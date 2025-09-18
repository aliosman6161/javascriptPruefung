// Routet klassifizierte Inbox-Dokumente nach processed/ oder review/ anhand min-Confidence.
// ESM, nur Node-Bordmittel, relative Pfade.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Pfade (relativ zu src/server/) ====
const ROOT_DIR      = path.resolve(__dirname, "../../");
const META_DIR      = process.env.META_DIR      || path.resolve(__dirname, "../../storage/meta");
const PROCESSED_DIR = process.env.PROCESSED_DIR || path.resolve(__dirname, "../../storage/processed");
const REVIEW_DIR    = process.env.REVIEW_DIR    || path.resolve(__dirname, "../../storage/review");

// ==== Routing-Regeln ====
const CONF_POLICY    = (process.env.CONF_POLICY || "min").toLowerCase(); // min|avg|max (wir nutzen min)
const CONF_THRESHOLD = Number(process.env.CONF_THRESHOLD || 0.7);
const USER_NAME      = process.env.USER_NAME || "system";

// ---------- helpers ----------
async function ensureDir(d) { await fs.promises.mkdir(d, { recursive: true }); }
function relFromRoot(abs) { return path.relative(ROOT_DIR, abs).split(path.sep).join("/"); }
async function readJson(p) { return JSON.parse(await fs.promises.readFile(p, "utf8")); }
async function writeJson(p, obj) { await fs.promises.writeFile(p, JSON.stringify(obj, null, 2), "utf8"); }

async function listMetaFiles() {
  await ensureDir(META_DIR);
  const names = await fs.promises.readdir(META_DIR);
  return names.filter(n => n.toLowerCase().endsWith(".json")).map(n => path.join(META_DIR, n));
}

function uniqueDestPath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  let i = 1;
  let candidate = path.join(dir, name);
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i++;
  }
  return candidate;
}

async function moveFile(srcAbs, dstDir) {
  await ensureDir(dstDir);
  const base = path.basename(srcAbs);
  const dstAbs = uniqueDestPath(dstDir, base);
  try {
    await fs.promises.rename(srcAbs, dstAbs);
  } catch (e) {
    if (e.code === "EXDEV" || e.code === "EPERM") {
      await fs.promises.copyFile(srcAbs, dstAbs);
      await fs.promises.unlink(srcAbs);
    } else {
      throw e;
    }
  }
  return dstAbs;
}

// classification shape helper:
// our classifier stored meta.classification.result = upstream response,
// which has a nested "result" containing doc fields.
function getInnerResult(classification) {
  // supports shapes:
  // { result: { class_id, custom_id, result: { kind, doc_id, ... } } }
  // or directly { kind, doc_id, ... }
  if (!classification) return null;
  if (classification.result && classification.result.result) return classification.result.result;
  if (classification.result && !classification.result.result) return classification.result;
  return classification;
}

function collectScores(inner) {
  const scores = [];
  if (inner?.doc_id?.score != null) scores.push(Number(inner.doc_id.score));
  if (inner?.doc_date_sic?.score != null) scores.push(Number(inner.doc_date_sic.score));
  if (inner?.doc_subject?.score != null) scores.push(Number(inner.doc_subject.score));
  return scores;
}

function aggregate(scores) {
  if (!scores.length) return 0;
  if (CONF_POLICY === "avg") return scores.reduce((a,b)=>a+b,0) / scores.length;
  if (CONF_POLICY === "max") return Math.max(...scores);
  return Math.min(...scores); // default: min
}

// ---------- routing of a single meta ----------
async function routeOne(metaPath) {
  const meta = await readJson(metaPath);

  // nur inbox-Dokumente mit vorhandener Klassifizierung verarbeiten
  if ((meta?.state || "").toLowerCase() !== "inbox") {
    return { skipped: true, reason: "state_not_inbox", docId: meta?.docId };
  }
  const inner = getInnerResult(meta?.classification);
  if (!inner) {
    return { skipped: true, reason: "no_classification", docId: meta?.docId };
  }

  // PDF-Pfad prüfen
  const pdfAbs = path.resolve(ROOT_DIR, meta.filePath || "");
  if (!fs.existsSync(pdfAbs)) {
    console.error(`❌ PDF fehlt auf Platte: ${meta.filePath} (docId=${meta.docId})`);
    return { ok: false, reason: "file_missing", docId: meta?.docId };
  }

  // min-Confidence bilden
  const scores = collectScores(inner);
  const agg = aggregate(scores);
  const toProcessed = agg >= CONF_THRESHOLD;
  const dstDir = toProcessed ? PROCESSED_DIR : REVIEW_DIR;

  // Datei verschieben
  const movedAbs = await moveFile(pdfAbs, dstDir);
  const newRel = relFromRoot(movedAbs);
  const newState = toProcessed ? "processed" : "review";

  // Meta aktualisieren
  meta.state = newState;
  meta.filePath = newRel;
  meta.routing = {
    policy: CONF_POLICY,
    threshold: CONF_THRESHOLD,
    aggregated_confidence: Number(agg.toFixed(4)),
    auto_processed: toProcessed,
    decided_at: new Date().toISOString(),
    decided_by: USER_NAME
  };
  meta.history = Array.isArray(meta.history) ? meta.history : [];
  meta.history.push({
    at: new Date().toISOString(),
    by: USER_NAME,
    event: "moved",
    from: "inbox",
    to: newState,
    note: `agg=${Number(agg.toFixed(4))}`
  });

  // zentrale Meta überschreiben
  await writeJson(metaPath, meta);
  // Kopie neben der verschobenen PDF
  await writeJson(path.join(path.dirname(movedAbs), `${meta.docId}.json`), meta);

  return { ok: true, docId: meta.docId, state: newState, agg };
}

// ---------- main ----------
async function run() {
  console.log(`Router gestartet → policy=${CONF_POLICY}, threshold=${CONF_THRESHOLD}`);
  console.log(`Meta: ${META_DIR}`);
  console.log(`Ziele: processed=${PROCESSED_DIR} | review=${REVIEW_DIR}`);

  const files = await listMetaFiles();
  if (!files.length) {
    console.log("Keine Meta-Dateien gefunden.");
    return;
  }

  let ok = 0, skipped = 0, fail = 0;
  for (const metaPath of files) {
    try {
      const r = await routeOne(metaPath);
      if (r?.ok) {
        ok++;
        console.log(`✅ ${r.docId} → ${r.state} (agg=${r.agg?.toFixed?.(4)})`);
      } else if (r?.skipped) {
        skipped++;
        // optional: console.log(`⏭️  skip (${r.reason}): ${r.docId}`);
      } else {
        fail++;
        console.log(`❌ fail (${r?.reason || "unknown"}): ${r?.docId || path.basename(metaPath)}`);
      }
    } catch (e) {
      fail++;
      console.log(`❌ Fehler bei ${path.basename(metaPath)}: ${e.message}`);
    }
  }

  console.log(`Fertig. Erfolgreich: ${ok}, Übersprungen: ${skipped}, Fehlgeschlagen: ${fail}`);
}

run().catch(e => {
  console.error("Unerwarteter Fehler:", e);
  process.exit(1);
});

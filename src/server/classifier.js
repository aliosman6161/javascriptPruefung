// Klassifiziert alle Inbox-Dokumente ohne vorhandene Klassifizierung
// und schreibt die Resultate in storage/meta/<docId>.json

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Pfade/Config (relativ, keine externen Libs) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR  = path.resolve(__dirname, "../../");
const META_DIR  = process.env.META_DIR || path.resolve(__dirname, "../../storage/meta");
const API_BASE  = (process.env.API_BASE || "http://localhost:8080/api/v1").replace(/\/+$/,"");

function absFromRoot(relPath) {
  return path.resolve(ROOT_DIR, relPath);
}

// UUID aus Dateinamen ziehen (z.B. "<uuid>.pdf")
function extractUuidFromFilename(name) {
  const m = String(name).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function readJson(p) {
  const raw = await fs.promises.readFile(p, "utf8");
  return JSON.parse(raw);
}

async function writeJson(p, obj) {
  await fs.promises.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

async function listMetaFiles() {
  await fs.promises.mkdir(META_DIR, { recursive: true });
  const names = await fs.promises.readdir(META_DIR);
  return names.filter(n => n.toLowerCase().endsWith(".json")).map(n => path.join(META_DIR, n));
}

async function classifyOne(metaPath) {
  const meta = await readJson(metaPath);

  // Nur state=inbox und ohne vorhandene Klassifizierung
  if ((meta?.state || "").toLowerCase() !== "inbox") return { skipped: true, reason: "state_not_inbox" };
  if (meta?.classification?.result) return { skipped: true, reason: "already_classified" };

  const relPdfPath = meta?.filePath;
  const originalFilename = meta?.originalFilename;
  if (!relPdfPath || !originalFilename) {
    return { skipped: true, reason: "meta_missing_fields" };
  }

  const uuid = extractUuidFromFilename(originalFilename) || extractUuidFromFilename(path.basename(relPdfPath));
  if (!uuid) {
    // UUID fehlt → sauber in Meta dokumentieren
    meta.classification = {
      fetchedAt: new Date().toISOString(),
      apiBase: API_BASE,
      requestUuid: null,
      error: { code: "invalid_filename", message: "Kein UUID im Dateinamen gefunden." }
    };
    await writeJson(metaPath, meta);
    return { ok: false, reason: "invalid_filename" };
  }

  const absPdfPath = absFromRoot(relPdfPath);
  if (!fs.existsSync(absPdfPath)) {
    meta.classification = {
      fetchedAt: new Date().toISOString(),
      apiBase: API_BASE,
      requestUuid: uuid,
      error: { code: "file_missing", message: `PDF fehlt: ${relPdfPath}` }
    };
    await writeJson(metaPath, meta);
    return { ok: false, reason: "file_missing" };
  }

  // PDF als raw application/pdf posten
  const pdfBuffer = await fs.promises.readFile(absPdfPath);
  const url = `${API_BASE}/classify/${uuid}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: pdfBuffer,
    });
  } catch (err) {
    meta.classification = {
      fetchedAt: new Date().toISOString(),
      apiBase: API_BASE,
      requestUuid: uuid,
      error: { code: "upstream_unavailable", message: String(err?.message || err) }
    };
    await writeJson(metaPath, meta);
    return { ok: false, reason: "upstream_unavailable" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    meta.classification = {
      fetchedAt: new Date().toISOString(),
      apiBase: API_BASE,
      requestUuid: uuid,
      error: { code: "upstream_http_error", status: res.status, statusText: res.statusText, body: text }
    };
    await writeJson(metaPath, meta);
    return { ok: false, reason: `http_${res.status}` };
  }

  // Erfolgreich – JSON übernehmen
  let result;
  try {
    result = await res.json();
  } catch (e) {
    const txt = await res.text().catch(() => "");
    meta.classification = {
      fetchedAt: new Date().toISOString(),
      apiBase: API_BASE,
      requestUuid: uuid,
      error: { code: "bad_upstream_response", message: "Antwort ist kein JSON", body: txt }
    };
    await writeJson(metaPath, meta);
    return { ok: false, reason: "bad_json" };
  }

  meta.classification = {
    fetchedAt: new Date().toISOString(),
    apiBase: API_BASE,
    requestUuid: uuid,
    result // enthält kind, doc_id, doc_date_sic, doc_date_parsed, doc_subject (+scores)
  };

  await writeJson(metaPath, meta);
  return { ok: true, uuid };
}

async function run() {
  console.log(`Classifier gestartet → API_BASE=${API_BASE}`);
  const files = await listMetaFiles();
  if (!files.length) {
    console.log("Keine Meta-Dateien gefunden.");
    return;
  }

  let ok = 0, skipped = 0, fail = 0;
  for (const metaPath of files) {
    try {
      const r = await classifyOne(metaPath);
      if (r?.ok) {
        ok++;
        console.log(`✅ Klassifiziert: ${path.basename(metaPath)} (uuid=${r.uuid})`);
      } else if (r?.skipped) {
        skipped++;
        // optional: console.log(`⏭️  Übersprungen (${r.reason}): ${path.basename(metaPath)}`);
      } else {
        fail++;
        console.log(`❌ Fehlgeschlagen (${r?.reason || "unknown"}): ${path.basename(metaPath)}`);
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

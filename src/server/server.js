// Server-Endpunkte:
// - GET  /api/health
// - GET  /api/docs?state=...           (Liste)
// - GET  /api/docs/:docId              (Detail)
// - GET  /api/docs/:docId/preview      (PDF streamen)
// - PATCH /api/docs/:docId/corrections (Korrekturen speichern)
// - POST  /api/docs/:docId/route       (manuell nach processed/review)
// - POST  /api/classify                (NEU: alle in inbox klassifizieren)
// - POST  /api/docs/:docId/classify    (NEU: einzelnes Dokument klassifizieren)
// - POST  /api/auto-route              (NEU: alle klassifizierten in inbox auto-routen)
// - POST  /api/docs/:docId/auto-route  (NEU: einzelnes Dokument auto-routen)

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR      = path.resolve(__dirname, "../../");
const META_DIR      = process.env.META_DIR      || path.resolve(__dirname, "../../storage/meta");
const INBOX_DIR     = process.env.INBOX_DIR     || path.resolve(__dirname, "../../storage/inbox");
const PROCESSED_DIR = process.env.PROCESSED_DIR || path.resolve(__dirname, "../../storage/processed");
const REVIEW_DIR    = process.env.REVIEW_DIR    || path.resolve(__dirname, "../../storage/review");
const HOLD_DIR      = process.env.HOLD_DIR      || path.resolve(__dirname, "../../storage/hold");

const PORT          = Number(process.env.PORT || 3001);
const USER_NAME     = process.env.USER_NAME || "system";
const CLASSIFIER_API_BASE = (process.env.CLASSIFIER_API_BASE || "http://localhost:8080/api/v1").replace(/\/+$/,"");






// ===== Helpers: Punkte 9, 10, 11 =====

// Erwartete Pfade/Variablen aus deinem Server (falls anders benannt, oben anpassen):
// ROOT_DIR, META_DIR, PROCESSED_DIR  – existieren bei dir bereits.
// saveMeta(metaPath, meta)           – falls du eine eigene Save-Funktion hast, weiter nutzen.
// readMeta(metaPath)                 – dito (nur Info).

// a) User aus Request ableiten (Body bevorzugt, sonst Fallback)
function resolveUser(req) {
  try {
    // 1) Body-Feld 'user' (falls vorhanden)
    if (req?.body && typeof req.body.user === "string" && req.body.user.trim()) {
      return req.body.user.trim();
    }
  } catch {}

  // 2) Header 'X-User' (global vom Frontend gesetzt)
  const h = req.headers?.["x-user"];
  if (typeof h === "string" && h.trim()) return h.trim();

  // 3) Fallback
  return "anonymous";
}


// b) min-Aggregat aus Klassifizierungs-Scores bestimmen (wie im Frontend)
  function getMinConfidence(meta) {
    const r = meta?.classification?.result?.result || meta?.classification?.result || null;
    if (!r) return null;

    const o = meta?.corrections?.conf_overrides || {};
    const sId   = (typeof o.doc_id_score === "number")       ? o.doc_id_score       : r?.doc_id?.score;
    const sDate = (typeof o.doc_date_sic_score === "number") ? o.doc_date_sic_score : r?.doc_date_sic?.score;
    const sSubj = (typeof o.doc_subject_score === "number")  ? o.doc_subject_score  : r?.doc_subject?.score;

    const scores = [];
    if (typeof sId   === "number") scores.push(Number(sId));
    if (typeof sDate === "number") scores.push(Number(sDate));
    if (typeof sSubj === "number") scores.push(Number(sSubj));

    if (!scores.length) return null;
    return scores.reduce((m, v) => Math.min(m, v), 1);
  }


// c) classification_mode für Processed setzen
function computeClassificationMode(meta, { isAutoRoute = false, threshold = 0.7 } = {}) {
  const hasCorrections =
    meta?.corrections && Object.keys(meta.corrections).some(k => String(meta.corrections[k] ?? "").trim() !== "");
  if (hasCorrections) return "corrected";

  const minConf = getMinConfidence(meta);
  if (isAutoRoute && minConf != null && Number(minConf) >= Number(threshold)) {
    return "auto";
  }
  return "manual";
}

// d) Sidecar-Meta im processed-Ordner ablegen (Punkt 9)
async function writeProcessedSidecarMeta(meta) {
  if (!meta?.docId) throw new Error("meta.docId fehlt");
  const file = path.join(PROCESSED_DIR, `${meta.docId}.json`);
  await fs.promises.mkdir(PROCESSED_DIR, { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(meta, null, 2), "utf8");
  return file;
}

// e) History-Eintrag anhängen (Punkt 11) + Haupt-Meta speichern
async function appendHistoryAndSave(metaPath, meta, entry) {
  meta.history = Array.isArray(meta.history) ? meta.history : [];
  meta.history.push({
    at: new Date().toISOString(),
    ...entry, // { action, from, to, by, note? }
  });
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

// f) Optionales Server-Logfile (Punkt 11 – Alternative/Ergänzung)
const LOG_DIR  = path.join(ROOT_DIR, "storage", "logs");
const LOG_FILE = path.join(LOG_DIR, "actions.log");
async function appendServerLog(entry) {
  try {
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(LOG_FILE, line, "utf8");
  } catch (e) {
    // Logfehler nicht eskalieren – es ist optional
    console.warn("logfile append failed:", e?.message || e);
  }
}







async function readAllMeta() {
  await fs.promises.mkdir(META_DIR, { recursive: true });
  const names = await fs.promises.readdir(META_DIR).catch(() => []);
  const metas = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith(".json")) continue;
    const p = path.join(META_DIR, n);
    try {
      const raw = await fs.promises.readFile(p, "utf8");
      metas.push(JSON.parse(raw));
    } catch { /* skip broken */ }
  }
  return metas;
}

async function readMetaById(docId) {
  const p = path.join(META_DIR, `${docId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = await fs.promises.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeMetaById(docId, meta) {
  const p = path.join(META_DIR, `${docId}.json`);
  await fs.promises.writeFile(p, JSON.stringify(meta, null, 2), "utf8");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function relFromRoot(abs) { return path.relative(ROOT_DIR, abs).split(path.sep).join("/"); }

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
  await fs.promises.mkdir(dstDir, { recursive: true });
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

function getInnerResult(classification) {
  if (!classification) return null;
  const r = classification.result;
  if (!r) return null;
  return r.result ? r.result : r;
}

function minConfidenceFromInner(inner) {
  const scores = [];
  if (inner?.doc_id?.score != null) scores.push(Number(inner.doc_id.score));
  if (inner?.doc_date_sic?.score != null) scores.push(Number(inner.doc_date_sic.score));
  if (inner?.doc_subject?.score != null) scores.push(Number(inner.doc_subject.score));
  if (!scores.length) return null;
  return scores.reduce((m,v) => Math.min(m, v), 1);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("invalid_json_body")); }
    });
    req.on("error", reject);
  });
}

// --- Classification helpers ---
async function classifyOne(meta) {
  const relPdf = meta.filePath;
  if (!relPdf) throw new Error("filePath not set in meta");
  const absPdf = path.resolve(ROOT_DIR, relPdf);
  if (!fs.existsSync(absPdf)) throw new Error(`PDF not found: ${relPdf}`);

  // uuid = Dateiname ohne .pdf
  const uuid = path.basename(absPdf).replace(/\.pdf$/i, "");
  const url = `${CLASSIFIER_API_BASE}/classify/${encodeURIComponent(uuid)}`;

  const bin = await fs.promises.readFile(absPdf);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "accept": "application/json" },
    body: bin
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`classifier HTTP ${res.status}: ${t || "error"}`);
  }
  const data = await res.json();

  meta.classification = {
    fetchedAt: new Date().toISOString(),
    apiBase: CLASSIFIER_API_BASE,
    requestUuid: uuid,
    result: data
  };
  meta.history = Array.isArray(meta.history) ? meta.history : [];
  meta.history.push({ at: new Date().toISOString(), by: USER_NAME, event: "classified" });

  await writeMetaById(meta.docId, meta);
  return meta;
}

async function autoRouteOne(meta, threshold = 0.7) {
  if (!meta.classification) throw new Error("not_classified");
  const min = getMinConfidence(meta); // nutzt KI-Scores ODER Overrides
  if (min == null) throw new Error("no_scores");


  const fromState = meta.state;
  const target = min >= threshold ? "processed" : "review";

  // move file
  const relPdf = meta.filePath;
  if (!relPdf) throw new Error("file_missing");
  const absPdf = path.resolve(ROOT_DIR, relPdf);
  if (!fs.existsSync(absPdf)) throw new Error(`PDF not found: ${relPdf}`);

  const dstDir = target === "processed" ? PROCESSED_DIR : REVIEW_DIR;
  const movedAbs = await moveFile(absPdf, dstDir);
  const newRel  = relFromRoot(movedAbs);

  meta.state = target;
  meta.filePath = newRel;
  meta.routing = {
    policy: "min",
    threshold,
    aggregated_confidence: min,
    auto_processed: target === "processed",
    decided_at: new Date().toISOString(),
    decided_by: USER_NAME
  };
  meta.history = Array.isArray(meta.history) ? meta.history : [];
  meta.history.push({ at: new Date().toISOString(), by: USER_NAME, event: "moved", from: fromState, to: target, note: `agg=${min}` });

  await writeMetaById(meta.docId, meta);
  // Kopie neben die PDF (optional hilfreich)
  await fs.promises.writeFile(path.join(path.dirname(movedAbs), `${meta.docId}.json`), JSON.stringify(meta, null, 2), "utf8");

  return meta;
}

// ---------- server ----------
export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const method = req.method || "GET";

      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User");
      if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

      // Health
      if (method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      // Liste
      if (method === "GET" && url.pathname === "/api/docs") {
        const state = url.searchParams.get("state") || "inbox";
        const all = await readAllMeta();
        const list = all
          .filter(m => (m?.state || "").toLowerCase() === state.toLowerCase())
          .map(m => ({
            docId: m.docId,
            state: m.state,
            originalFilename: m.originalFilename,
            filePath: m.filePath,
            createdAt: m.createdAt,
          }))
          .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return sendJson(res, 200, { items: list, count: list.length });
      }

      // Detail
      if (method === "GET" && url.pathname.startsWith("/api/docs/") && !url.pathname.endsWith("/preview")) {
        const docId = url.pathname.split("/").pop();
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });
        return sendJson(res, 200, meta);
      }

      // Preview
      if (method === "GET" && url.pathname.endsWith("/preview")) {
        const parts = url.pathname.split("/").filter(Boolean); // ["api","docs",":docId","preview"]
        const docId = parts[2];
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });

        const relPdf = meta.filePath;
        if (!relPdf) return sendJson(res, 409, { error: "file_missing", message: "filePath not set in meta" });

        const absPdf = path.resolve(ROOT_DIR, relPdf);
        if (!fs.existsSync(absPdf)) return sendJson(res, 409, { error: "file_missing", message: `PDF not found: ${relPdf}` });

        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${encodeURIComponent(meta.originalFilename || `${docId}.pdf`)}"`,
          "Cache-Control": "no-store"
        });
        const stream = fs.createReadStream(absPdf);
        stream.on("error", () => { if (!res.writableEnded) res.end(); });
        return stream.pipe(res);
      }

      // Korrekturen speichern
      if (method === "PATCH" && /^\/api\/docs\/[^/]+\/corrections$/.test(url.pathname)) {
        const docId = url.pathname.split("/")[3];
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });

        const body = await readJsonBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: "invalid_json_body" });


        



        const allowed = ["kind", "doc_id", "doc_date_sic", "doc_date_parsed", "doc_subject"];
        const patch = {};
        for (const k of allowed) {
          if (body[k] != null) patch[k] = String(body[k]);
        }
        meta.corrections = { ...(meta.corrections || {}), ...patch };
        meta.correctedAt = new Date().toISOString();
        meta.correctedBy = USER_NAME;

        // ⬇️ NEU: Confidence-Overrides (0..1; "" = löschen)
        if (body && typeof body.conf_overrides === "object") {
          const co = body.conf_overrides || {};
          const keys = ["doc_id_score","doc_date_sic_score","doc_subject_score"];

          // Zielstruktur sicherstellen
          const target = { ...(meta.corrections.conf_overrides || {}) };

          for (const k of keys) {
            const v = co[k];
            if (v === "" || v === null || typeof v === "undefined") {
              delete target[k];                 // leeres Feld => Override entfernen
            } else {
              const n = Number(v);
              if (isFinite(n) && n >= 0 && n <= 1) target[k] = n; // clampen macht schon das Frontend
            }
          }
          if (Object.keys(target).length === 0) {
            if (meta.corrections.conf_overrides) delete meta.corrections.conf_overrides;
          } else {
            meta.corrections.conf_overrides = target;
          }
        }






        meta.history = Array.isArray(meta.history) ? meta.history : [];
        meta.history.push({ at: new Date().toISOString(), by: USER_NAME, event: "corrections_saved" });

        await writeMetaById(docId, meta);




        {
          const by = resolveUser(req);
          const metaPath = path.join(META_DIR, `${meta.docId}.json`);
          await appendHistoryAndSave(metaPath, meta, { action: "corrections", by });
          await appendServerLog({ docId: meta.docId, action: "corrections", by });
        }





        return sendJson(res, 200, meta);
      }

      // Manuelles Routing
      if (method === "POST" && /^\/api\/docs\/[^/]+\/route$/.test(url.pathname)) {
        const docId = url.pathname.split("/")[3];
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });

        const body = await readJsonBody(req).catch(() => null);
        if (!body || !body.to) return sendJson(res, 400, { error: "bad_request", message: "body.to required" });

        const to = String(body.to).toLowerCase();
        if (!["processed","review","hold","inbox"].includes(to)) {
          return sendJson(res, 400, { error: "bad_request", message: "to must be 'processed', 'review', 'hold' or 'inbox'" });
        }


        const relPdf = meta.filePath;
        if (!relPdf) return sendJson(res, 409, { error: "file_missing", message: "filePath not set in meta" });
        const absPdf = path.resolve(ROOT_DIR, relPdf);
        if (!fs.existsSync(absPdf)) return sendJson(res, 409, { error: "file_missing", message: `PDF not found: ${relPdf}` });

        const dstDir = to === "processed" ? PROCESSED_DIR
              : to === "review"   ? REVIEW_DIR
              : to === "hold"     ? HOLD_DIR
              :                      INBOX_DIR; // fallback: inbox
        const movedAbs = await moveFile(absPdf, dstDir);
        const newRel  = relFromRoot(movedAbs);

        const fromState = meta.state;
        meta.state = to;
        meta.filePath = newRel;
        meta.history = Array.isArray(meta.history) ? meta.history : [];
        meta.history.push({ at: new Date().toISOString(), by: USER_NAME, event: "moved", from: fromState, to });


        await writeMetaById(docId, meta);






        // Zusatz: nur bei Ziel 'processed' Modus setzen + History/Log, damit Sidecar die Info enthält
        if (to === "processed") {
          const by = resolveUser(req);
          meta.classification_mode = computeClassificationMode(meta, { isAutoRoute: false, threshold: 0.7 });

          // in die Haupt-Meta schreiben (appendHistoryAndSave speichert die Datei)
          await appendHistoryAndSave(path.join(META_DIR, `${meta.docId}.json`), meta, {
            action: "route",
            from: fromState || meta.state,
            to: "processed",
            by,
          });

          // optionales Server-Log
          await appendServerLog({ docId: meta.docId, action: "route", from: fromState || meta.state, to: "processed", by });
        }








        await fs.promises.writeFile(path.join(path.dirname(movedAbs), `${docId}.json`), JSON.stringify(meta, null, 2), "utf8");

        return sendJson(res, 200, meta);
      }

      // === NEU: Einzel-Klassifizierung ===
      if (method === "POST" && /^\/api\/docs\/[^/]+\/classify$/.test(url.pathname)) {
        const docId = url.pathname.split("/")[3];
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });
        try {
          await classifyOne(meta);



          {
            const by = resolveUser(req);
            const metaPath = path.join(META_DIR, `${meta.docId}.json`);
            await appendHistoryAndSave(metaPath, meta, { action: "classify", by });
            await appendServerLog({ docId: meta.docId, action: "classify", by });
          }





          return sendJson(res, 200, { ok: true, docId });
        } catch (e) {
          return sendJson(res, 502, { ok:false, error: "classify_failed", message: String(e?.message || e) });
        }
      }

      // === NEU: Bulk-Klassifizierung (Inbox) ===
      if (method === "POST" && url.pathname === "/api/classify") {
        const body = await readJsonBody(req).catch(() => ({}));
        const reclassify = Boolean(body?.reclassify);
        const all = await readAllMeta();
        const inbox = all.filter(m => (m?.state || "").toLowerCase() === "inbox");
        let ok = 0, fail = 0;
        for (const meta of inbox) {
          if (!reclassify && meta.classification) continue; // bereits klassifiziert → überspringen
          try { await classifyOne(meta); ok++; } catch { fail++; }
        }
        return sendJson(res, 200, { ok, fail, scanned: inbox.length });
      }

      // === NEU: Einzel-Auto-Route ===
      if (method === "POST" && /^\/api\/docs\/[^/]+\/auto-route$/.test(url.pathname)) {
        const docId = url.pathname.split("/")[3];
        const meta = await readMetaById(docId);
        if (!meta) return sendJson(res, 404, { error: "not_found", message: `meta for docId ${docId} not found` });

        const body = await readJsonBody(req).catch(() => ({}));
        const threshold = Number(body?.threshold ?? 0.7);

        try {
          await autoRouteOne(meta, threshold);




          
          // Nur wenn Ergebnis processed: Modus setzen + History/Log + Sidecar aktualisieren
          if (meta.state === "processed") {
            const by = resolveUser(req);
            const usedThreshold = typeof threshold === "number" ? threshold : 0.7;

            meta.classification_mode = computeClassificationMode(meta, { isAutoRoute: true, threshold: usedThreshold });

            // Haupt-Meta + History
            await appendHistoryAndSave(path.join(META_DIR, `${meta.docId}.json`), meta, {
              action: "auto_route",
              from: "inbox",
              to: "processed",
              by,
              threshold: usedThreshold
            });

            // Sidecar-JSON im processed-Ordner mit aktualisiertem meta überschreiben
            await writeProcessedSidecarMeta(meta);

            // optionales Server-Log
            await appendServerLog({ docId: meta.docId, action: "auto_route", from: "inbox", to: "processed", by, threshold: usedThreshold });
          }







          return sendJson(res, 200, { ok:true, docId, newState: meta.state });
        } catch (e) {
          if (String(e?.message).includes("not_classified")) {
            return sendJson(res, 409, { ok:false, error:"not_classified", message:"document not classified" });
          }
          return sendJson(res, 500, { ok:false, error:"route_failed", message:String(e?.message || e) });
        }
      }

      // === NEU: Bulk-Auto-Route (Inbox, nur klassifizierte) ===
      if (method === "POST" && url.pathname === "/api/auto-route") {
        const body = await readJsonBody(req).catch(() => ({}));
        const threshold = Number(body?.threshold ?? 0.7);
        const by = resolveUser(req);
        const all = await readAllMeta();
        const inbox = all.filter(m => (m?.state || "").toLowerCase() === "inbox");
        let processed = 0, reviewed = 0, skipped = 0, failed = 0;

        for (const meta of inbox) {
          if (!meta.classification) { skipped++; continue; }
          try {
            const before = meta.state;
            await autoRouteOne(meta, threshold);



            // Wenn diese Datei nach processed ging: Modus setzen + History/Log + Sidecar aktualisieren
            if (meta.state === "processed") {
              const usedThreshold = typeof threshold === "number" ? threshold : 0.7;

              // (10) classification_mode bestimmen
              meta.classification_mode = computeClassificationMode(meta, { isAutoRoute: true, threshold: usedThreshold });

              // (11) History + optionales Server-Log
              await appendHistoryAndSave(path.join(META_DIR, `${meta.docId}.json`), meta, {
                action: "auto_route",
                from: "inbox",
                to: "processed",
                by,
                threshold: usedThreshold
              });

              // (9) Sidecar-JSON im processed-Ordner mit aktualisiertem Meta überschreiben
              await writeProcessedSidecarMeta(meta);
              await appendServerLog({ docId: meta.docId, action: "auto_route", from: "inbox", to: "processed", by, threshold: usedThreshold });
            }




            if (meta.state === "processed") processed++;
            else if (meta.state === "review") reviewed++;
            else skipped++; // sollte nicht passieren
          } catch { failed++; }
        }
        return sendJson(res, 200, { processed, reviewed, skipped, failed, scanned: inbox.length });
      }




      // === NEU: Manueller Upload (multipart) ===
if (method === "POST" && url.pathname === "/api/upload") {
  const ct = req.headers["content-type"] || "";
  const m = ct.match(/multipart\/form-data;\s*boundary=(.+)/i);
  if (!m) return sendJson(res, 400, { error: "bad_content_type", message: "multipart/form-data expected" });
  const boundary = "--" + m[1];

  // Anfrage puffern (einfach, da per-Datei-Limit 25 MB)
  const chunks = [];
  let total = 0;
  const MAX_TOTAL = 200 * 1024 * 1024;
  req.on("data", (c) => { total += c.length; if (total > MAX_TOTAL) req.destroy(); chunks.push(c); });
  await new Promise((resolve) => { req.on("end", resolve); req.on("close", resolve); });

  const buf = Buffer.concat(chunks);
  const parts = buf.toString("binary").split(boundary).slice(1, -1); // drop preamble/epilogue

  await fs.promises.mkdir(INBOX_DIR, { recursive: true });
  await fs.promises.mkdir(META_DIR, { recursive: true });

  const created = [];

  for (const part of parts) {
    const idx = part.indexOf("\r\n\r\n");
    if (idx === -1) continue;
    const header = part.slice(0, idx);
    let bodyBinary = part.slice(idx + 4);
    if (bodyBinary.endsWith("\r\n")) bodyBinary = bodyBinary.slice(0, -2);

    const cdm = header.match(/Content-Disposition:[\s\S]*?name="([^"]+)"(?:;[\s]*filename="([^"]+)")?/i);
    const ctm = header.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!cdm) continue;

    const field = cdm[1];
    const filename = cdm[2];
    if (field !== "files" || !filename) continue;

    const mime = (ctm?.[1] || "").toLowerCase();
    const isPdfByMime = mime === "application/pdf";
    const isPdfByName = filename.toLowerCase().endsWith(".pdf");
    if (!isPdfByMime && !isPdfByName) {
      return sendJson(res, 415, { error: "unsupported_type", message: `Not a PDF: ${filename}` });
    }

    const fileBuf = Buffer.from(bodyBinary, "binary");
    const MAX_FILE = 25 * 1024 * 1024;
    if (fileBuf.length > MAX_FILE) {
      return sendJson(res, 413, { error: "file_too_large", message: `${filename} > 25MB` });
    }

    // Signaturcheck
    const head = fileBuf.subarray(0, 5).toString("utf8");
    if (!head.startsWith("%PDF-")) {
      return sendJson(res, 415, { error: "invalid_pdf", message: `${filename} has no %PDF- signature` });
    }

    const dstAbs = uniqueDestPath(INBOX_DIR, filename);
    await fs.promises.writeFile(dstAbs, fileBuf);

    // Meta wie beim Scanner
    const { randomUUID } = await import("crypto");
    const docId = randomUUID();
    const meta = {
      docId,
      state: "inbox",
      originalFilename: path.basename(dstAbs),
      filePath: relFromRoot(dstAbs),
      createdAt: new Date().toISOString(),
      createdBy: USER_NAME,
      history: [
        { at: new Date().toISOString(), by: USER_NAME, event: "moved", from: "upload", to: "inbox" }
      ]
    };
    await writeMetaById(docId, meta);
    created.push(docId);



    {
      const by = resolveUser(req);
      await appendServerLog({ docId, action: "upload", by });
    }




  }

  return sendJson(res, 201, { created });
}


// === Simple Login (Demo) ===
// Erwartet JSON: { username, password }
// Aktuell: nur admin/admin ist gültig.
if (method === "POST" && url.pathname === "/api/auth/login") {
  try {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    await new Promise((resolve) => { req.on("end", resolve); req.on("close", resolve); });

    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}

    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");

    if (username === "admin" && password === "admin") {
      return sendJson(res, 200, { ok: true, username: "admin" });
    }
    return sendJson(res, 401, { ok: false, message: "Ungültige Zugangsdaten." });
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: "Serverfehler beim Login." });
  }
}








      // Fallback
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      sendJson(res, 500, { error: "server_error", message: String(err?.message || err) });
    }
  });

  server.listen(PORT, () => {
    console.log(`HTTP-Server läuft auf http://localhost:${PORT}`);
    console.log(`Classifier API: ${CLASSIFIER_API_BASE}`);
  });

  return { stop: () => new Promise(resolve => server.close(() => resolve())) };
}

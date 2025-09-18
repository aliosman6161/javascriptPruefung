// ESM – Scanner → Inbox + Meta-Erzeugung (keine externen Pakete)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Projekt-Root und Standardpfade (relativ zu DIESER Datei)
const ROOT_DIR   = path.resolve(__dirname, "../../");
const SCANNER_DIR =
  process.env.SCANNER_DIR || path.resolve(__dirname, "../../../pdfclassifier-api-mock-1_1_0/tmp");
const INBOX_DIR  =
  process.env.INBOX_DIR  || path.resolve(__dirname, "../../storage/inbox");
const META_DIR   =
  process.env.META_DIR   || path.resolve(__dirname, "../../storage/meta");

const POLL_MS   = Number(process.env.POLL_MS || 3000);
const USER_NAME = process.env.USER_NAME || "system";

// --- Helfer ---
function isPdf(name) { return /\.pdf$/i.test(name); }
async function ensureDir(dir) { await fs.promises.mkdir(dir, { recursive: true }); }
function relFromRoot(absPath) { return path.relative(ROOT_DIR, absPath).split(path.sep).join("/"); }

async function uniqueDest(dir, name) {
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

async function isStable(filePath) {
  try {
    const a = await fs.promises.stat(filePath);
    await new Promise(r => setTimeout(r, 300));
    const b = await fs.promises.stat(filePath);
    return a.size === b.size;
  } catch { return false; }
}

async function moveOne(src, dstDir) {
  const name = path.basename(src);
  const dst = await uniqueDest(dstDir, name);
  try {
    await fs.promises.rename(src, dst);
  } catch (e) {
    if (e.code === "EXDEV" || e.code === "EPERM") {
      await fs.promises.copyFile(src, dst);
      await fs.promises.unlink(src);
    } else {
      throw e;
    }
  }
  return dst;
}

async function writeMetaForMoved(movedAbsPath, originalFilename) {
  await ensureDir(META_DIR);

  const docId = crypto.randomUUID();
  const meta = {
    docId,
    state: "inbox",
    originalFilename,
    filePath: relFromRoot(movedAbsPath),      // z.B. "storage/inbox/foo.pdf"
    createdAt: new Date().toISOString(),
    createdBy: USER_NAME,
    history: [
      {
        at: new Date().toISOString(),
        by: USER_NAME,
        event: "moved",
        from: "scanner",
        to: "inbox"
      }
    ]
  };

  const metaPath = path.join(META_DIR, `${docId}.json`);
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return { docId, metaPath };
}

// --- Takt ---
async function tick() {
  await ensureDir(SCANNER_DIR);
  await ensureDir(INBOX_DIR);
  await ensureDir(META_DIR);

  let entries = [];
  try {
    entries = await fs.promises.readdir(SCANNER_DIR, { withFileTypes: true });
  } catch (e) {
    console.error(`❌ Kann Scanner-Ordner nicht lesen: ${SCANNER_DIR}\n${e.message}`);
    return;
  }

  const pdfs = entries
    .filter(e => e.isFile() && isPdf(e.name))
    .map(e => path.join(SCANNER_DIR, e.name));

  if (!pdfs.length) return;

  for (const src of pdfs) {
    const name = path.basename(src);
    try {
      if (!(await isStable(src))) {
        console.log(`⏳ Datei noch in Arbeit, übersprungen: ${name}`);
        continue;
      }
      const movedAbs = await moveOne(src, INBOX_DIR);
      const { docId, metaPath } = await writeMetaForMoved(movedAbs, name);

      console.log(`📥 Verschoben: ${name}`);
      console.log(`   → ${relFromRoot(movedAbs)} | Meta: ${relFromRoot(metaPath)} (docId=${docId})`);
    } catch (e) {
      console.error(`❌ Fehler bei ${name}: ${e.message}`);
    }
  }
}

// --- Public API ---
export function startScannerWatcher() {
  console.log(`Watcher gestartet (alle ${POLL_MS}ms)`);
  console.log(`Quelle (scanner): ${SCANNER_DIR}`);
  console.log(`Ziel   (inbox)  : ${INBOX_DIR}`);
  console.log(`Meta  (ablage)  : ${META_DIR}`);

  tick();
  const timer = setInterval(tick, POLL_MS);
  const stop = () => clearInterval(timer);
  return { stop };
}

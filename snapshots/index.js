// Zentraler Einstieg: startet Watcher + Mini-API
import { startScannerWatcher } from "./scanner_to_inbox.js";
import { startServer } from "./server.js";

const { stop: stopWatcher } = startScannerWatcher();
const { stop: stopServer }  = startServer();

async function shutdown() {
  await Promise.all([ stopWatcher?.(), stopServer?.() ]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

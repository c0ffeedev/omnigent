import { createTeamsApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ActivityDedupeStore } from "./dedupe.js";

const config = loadConfig();
const dedupe = new ActivityDedupeStore(config.dedupeDatabase, {
  maxRecords: config.dedupeMaxRecords,
  retentionDays: config.dedupeRetentionDays,
});
const app = createTeamsApp(config, dedupe);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await app.stop();
  } finally {
    dedupe.close();
  }
}

process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

await app.start(config.port);

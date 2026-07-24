import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { ActivityDedupeStore } from "../../src/dedupe.js";

const [databasePath, gatePath, owner] = process.argv.slice(2);
if (!databasePath || !gatePath || !owner) throw new Error("database path, gate path, and owner are required");

while (!existsSync(gatePath)) await delay(5);

const store = new ActivityDedupeStore(databasePath, {
  leaseMilliseconds: 5_000,
  maxRecords: 100,
  retentionDays: 7,
});
const key = {
  botAppId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  conversationId: "conversation-1",
  senderId: "sender-1",
  activityId: "shared-activity",
};
const claim = store.claim(key, { kind: "teams_reply", payload: "help" }, owner);
if (claim.status === "acquired") {
  await delay(100);
  store.complete(key, owner, `reply-${owner}`);
}
store.close();

process.stdout.write(JSON.stringify({ status: claim.status }));

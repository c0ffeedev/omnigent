import { createTeamsApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ActivityDedupeStore } from "./dedupe.js";
import { GrantStore } from "./grants.js";
import { EntraJwtValidator } from "./identity.js";
import { GrantLifecycle } from "./lifecycle.js";
import { OmnigentDeviceClient } from "./omnigent.js";

const config = loadConfig();
const dedupe = new ActivityDedupeStore(config.dedupeDatabase, {
  maxRecords: config.dedupeMaxRecords,
  retentionDays: config.dedupeRetentionDays,
});
const grants = new GrantStore(config.grantDatabase, config.tokenEncryptionKey, {
  maximumLifetimeDays: config.grantMaximumLifetimeDays,
});
const lifecycle = new GrantLifecycle(
  config.botAppId,
  config.omnigentOrigin,
  grants,
  new OmnigentDeviceClient({
    clientId: config.omnigentDeviceClientId,
    clientSecret: config.omnigentDeviceClientSecret,
    origin: config.omnigentOrigin,
  }),
);
const app = createTeamsApp(config, dedupe, {}, {
  identityValidator: new EntraJwtValidator({
    allowedTenantIds: config.allowedTenantIds,
    audience: config.ssoAudience,
  }),
  lifecycle,
});

let stopping = false;
let reconciliation: NodeJS.Timeout | undefined;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (reconciliation) clearInterval(reconciliation);
  try {
    await app.stop();
  } finally {
    dedupe.close();
    grants.close();
  }
}

process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

await lifecycle.reconcileRevocations();
reconciliation = setInterval(() => void lifecycle.reconcileRevocations(), 60_000);
reconciliation.unref();
await app.start(config.port);

import { App, type AppOptions } from "@microsoft/teams.apps";

import { handlePersonalMessage, validateActivity } from "./activity.js";
import type { TeamsConfig } from "./config.js";
import { ActivityDedupeStore } from "./dedupe.js";

export type TeamsAppOptions = Pick<AppOptions<never>, "client" | "cloud" | "httpServerAdapter" | "logger">;

export function createTeamsApp(
  config: TeamsConfig,
  dedupe: ActivityDedupeStore,
  options: TeamsAppOptions = {},
): App {
  const constraints = {
    botAppId: config.botAppId,
    allowedTenantIds: config.allowedTenantIds,
  };
  const app = new App({
    clientId: config.botAppId,
    clientSecret: config.botClientSecret,
    tenantId: config.botTenantId,
    messagingEndpoint: "/api/messages",
    activity: { mentions: { stripText: true } },
    client: { timeout: 10_000 },
    ...options,
  });

  app.use(async ({ activity, next }) => {
    const validation = validateActivity(activity, constraints);
    if (!validation.ok) {
      return { status: validation.status, body: { error: validation.reason } };
    }
    return next();
  });

  app.on("message", async ({ activity, reply }) => {
    await handlePersonalMessage(activity, constraints, dedupe, (message) => reply(message));
  });

  return app;
}

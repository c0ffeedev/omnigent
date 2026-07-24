import { App, type AppOptions } from "@microsoft/teams.apps";
import { ConsoleLogger, type ILogger, type ILoggerOptions, type LogLevel } from "@microsoft/teams.common";

import { handlePersonalMessage, validateActivity } from "./activity.js";
import type { TeamsConfig } from "./config.js";
import { ActivityDedupeStore } from "./dedupe.js";

export type TeamsAppOptions = Pick<AppOptions<never>, "client" | "cloud" | "httpServerAdapter" | "logger">;

class RedactingLogger implements ILogger {
  readonly loggerOptions?: ILoggerOptions;

  constructor(
    private readonly delegate: ILogger,
    private readonly secrets: readonly string[],
  ) {
    this.loggerOptions = delegate.loggerOptions;
  }

  private safe(message: unknown): string {
    let safe = typeof message === "string" ? message : "[redacted structured log argument]";
    safe = safe.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
    safe = safe.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
    for (const secret of this.secrets) safe = safe.split(secret).join("[redacted secret]");
    return safe;
  }

  private write(level: LogLevel, message: unknown): void {
    this.delegate.log(level, this.safe(message));
  }

  debug(message: unknown): void { this.write("debug", message); }
  info(message: unknown): void { this.write("info", message); }
  warn(message: unknown): void { this.write("warn", message); }
  error(message: unknown): void { this.write("error", message); }
  trace(message: unknown): void { this.write("trace", message); }
  log(level: LogLevel, message: unknown): void { this.write(level, message); }

  child(name: string, overrides?: ILoggerOptions): ILogger {
    return new RedactingLogger(this.delegate.child(name, overrides), this.secrets);
  }
}

export function createTeamsApp(
  config: TeamsConfig,
  dedupe: ActivityDedupeStore,
  options: TeamsAppOptions = {},
): App {
  const constraints = {
    botAppId: config.botAppId,
    allowedTenantIds: config.allowedTenantIds,
  };
  const { logger, ...sdkOptions } = options;
  const app = new App({
    clientId: config.botAppId,
    clientSecret: config.botClientSecret,
    tenantId: config.botTenantId,
    messagingEndpoint: "/api/messages",
    activity: { mentions: { stripText: true } },
    client: { timeout: 10_000 },
    ...sdkOptions,
    logger: new RedactingLogger(logger ?? new ConsoleLogger("omnigent/teams"), [config.botClientSecret]),
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

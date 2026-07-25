import { App, type AppOptions } from "@microsoft/teams.apps";
import { ConsoleLogger, type ILogger, type ILoggerOptions, type LogLevel } from "@microsoft/teams.common";

import {
  HELP_TEXT,
  UNSUPPORTED_TEXT,
  handlePersonalMessage,
  validateActivity,
  type ValidatedActivity,
} from "./activity.js";
import type { TeamsConfig } from "./config.js";
import { ActivityDedupeStore } from "./dedupe.js";
import { EntraJwtValidator } from "./identity.js";
import type { GrantLifecycle } from "./lifecycle.js";

export type TeamsAppOptions = Pick<AppOptions<never>, "client" | "cloud" | "httpServerAdapter" | "logger">;

export interface TeamsAppServices {
  identityValidator: EntraJwtValidator;
  lifecycle: GrantLifecycle;
}

export async function respondToPersonalCommand(
  signin: (options: { connectionName: string }) => Promise<string | undefined>,
  reply: (message: string) => Promise<unknown>,
  validated: ValidatedActivity,
  command: string | undefined,
  config: Pick<TeamsConfig, "ssoConnectionName">,
  services?: TeamsAppServices,
): Promise<string> {
  if (command === "help") return HELP_TEXT;
  if (!services || !["connect", "status", "logout"].includes(command ?? "")) return UNSUPPORTED_TEXT;

  const token = await signin({ connectionName: config.ssoConnectionName });
  if (!token) return "Complete Microsoft sign-in, then send the command again.";
  let principal;
  try {
    principal = await services.identityValidator.validate(token, validated);
  } catch {
    return "Microsoft sign-in could not be verified for this Teams account.";
  }
  if (command === "status") return services.lifecycle.status(principal);
  if (command === "logout") return services.lifecycle.logout(principal);
  const result = await services.lifecycle.connect(principal);
  void result.completion.then((message) => reply(message)).catch(() => undefined);
  return result.message;
}

export class RedactingLogger implements ILogger {
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
  services?: TeamsAppServices,
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
    oauth: { defaultConnectionName: config.ssoConnectionName },
    ...sdkOptions,
    logger: new RedactingLogger(
      logger ?? new ConsoleLogger("omnigent/teams"),
      [config.botClientSecret, config.omnigentDeviceClientSecret ?? ""].filter(Boolean),
    ),
  });

  app.use(async ({ activity, next }) => {
    const validation = validateActivity(activity, constraints);
    if (!validation.ok) {
      return { status: validation.status, body: { error: validation.reason } };
    }
    return next();
  });

  app.on("message", async ({ activity, reply, signin }) => {
    await handlePersonalMessage(
      activity,
      constraints,
      dedupe,
      (message) => reply(message),
      (validated, command) => respondToPersonalCommand(signin, reply, validated, command, config, services),
    );
  });

  if (services) {
    app.on("install.remove", async ({ activity }) => {
      const validation = validateActivity(activity, constraints);
      if (!validation.ok) return;
      services.lifecycle.uninstall({ objectId: validation.senderId, tenantId: validation.tenantId });
    });
  }

  return app;
}

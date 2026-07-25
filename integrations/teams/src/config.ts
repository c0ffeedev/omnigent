import { resolve } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TeamsConfig {
  botAppId: string;
  botClientSecret: string;
  botTenantId: string;
  allowedTenantIds: ReadonlySet<string>;
  ssoAudience: string;
  ssoConnectionName: string;
  omnigentOrigin: string;
  omnigentDeviceClientId: string;
  omnigentDeviceClientSecret?: string;
  grantDatabase: string;
  tokenEncryptionKey: Buffer;
  grantMaximumLifetimeDays: number;
  dedupeDatabase: string;
  dedupeRetentionDays: number;
  dedupeMaxRecords: number;
  port: number;
}

function boolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function origin(env: NodeJS.ProcessEnv): string {
  const raw = required(env, "OMNIGENT_ORIGIN");
  const allowLoopback = boolean(
    env.TEAMS_DEVELOPMENT_ALLOW_HTTP_LOOPBACK,
    "TEAMS_DEVELOPMENT_ALLOW_HTTP_LOOPBACK",
  );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OMNIGENT_ORIGIN must be an absolute URL");
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(allowLoopback && parsed.protocol === "http:" && loopback)) {
    throw new Error("OMNIGENT_ORIGIN must use HTTPS (loopback HTTP requires explicit development mode)");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("OMNIGENT_ORIGIN must contain only scheme, host, and optional port");
  }
  return parsed.origin;
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = required(env, "TEAMS_TOKEN_ENCRYPTION_KEY");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("TEAMS_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("TEAMS_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function integer(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TeamsConfig {
  const configuredGrantLifetime = env.TEAMS_GRANT_MAXIMUM_LIFETIME_DAYS?.trim();
  if (configuredGrantLifetime && configuredGrantLifetime !== "30") {
    throw new Error("TEAMS_GRANT_MAXIMUM_LIFETIME_DAYS must match the server lifetime of 30 days");
  }
  const allowlist = required(env, "TEAMS_ALLOWED_TENANT_IDS")
    .split(",")
    .map((value) => uuid(value.trim(), "TEAMS_ALLOWED_TENANT_IDS"));
  const allowedTenantIds = new Set(allowlist);
  if (allowedTenantIds.size !== allowlist.length) {
    throw new Error("TEAMS_ALLOWED_TENANT_IDS must not contain duplicate tenant IDs");
  }

  return {
    botAppId: uuid(required(env, "TEAMS_BOT_APP_ID"), "TEAMS_BOT_APP_ID"),
    botClientSecret: required(env, "TEAMS_BOT_CLIENT_SECRET"),
    botTenantId: uuid(required(env, "TEAMS_BOT_TENANT_ID"), "TEAMS_BOT_TENANT_ID"),
    allowedTenantIds,
    ssoAudience: required(env, "TEAMS_SSO_AUDIENCE"),
    ssoConnectionName: required(env, "TEAMS_SSO_CONNECTION_NAME"),
    omnigentOrigin: origin(env),
    omnigentDeviceClientId: required(env, "OMNIGENT_DEVICE_CLIENT_ID"),
    omnigentDeviceClientSecret: env.OMNIGENT_DEVICE_CLIENT_SECRET?.trim() || undefined,
    grantDatabase: resolve(required(env, "TEAMS_GRANT_DATABASE")),
    tokenEncryptionKey: encryptionKey(env),
    grantMaximumLifetimeDays: 30,
    dedupeDatabase: resolve(required(env, "TEAMS_DEDUPE_DATABASE")),
    dedupeRetentionDays: integer(env.TEAMS_DEDUPE_RETENTION_DAYS, 7, "TEAMS_DEDUPE_RETENTION_DAYS", 1, 365),
    dedupeMaxRecords: integer(env.TEAMS_DEDUPE_MAX_RECORDS, 100_000, "TEAMS_DEDUPE_MAX_RECORDS", 1, 10_000_000),
    port: integer(env.PORT, 3978, "PORT", 1, 65_535),
  };
}

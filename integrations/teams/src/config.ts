import { resolve } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TeamsConfig {
  botAppId: string;
  botClientSecret: string;
  botTenantId: string;
  allowedTenantIds: ReadonlySet<string>;
  dedupeDatabase: string;
  dedupeRetentionDays: number;
  dedupeMaxRecords: number;
  port: number;
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
  const allowlist = required(env, "TEAMS_ALLOWED_TENANT_IDS")
    .split(",")
    .map((value) => uuid(value.trim(), "TEAMS_ALLOWED_TENANT_IDS"));

  return {
    botAppId: uuid(required(env, "TEAMS_BOT_APP_ID"), "TEAMS_BOT_APP_ID"),
    botClientSecret: required(env, "TEAMS_BOT_CLIENT_SECRET"),
    botTenantId: uuid(required(env, "TEAMS_BOT_TENANT_ID"), "TEAMS_BOT_TENANT_ID"),
    allowedTenantIds: new Set(allowlist),
    dedupeDatabase: resolve(required(env, "TEAMS_DEDUPE_DATABASE")),
    dedupeRetentionDays: integer(env.TEAMS_DEDUPE_RETENTION_DAYS, 7, "TEAMS_DEDUPE_RETENTION_DAYS", 1, 365),
    dedupeMaxRecords: integer(env.TEAMS_DEDUPE_MAX_RECORDS, 100_000, "TEAMS_DEDUPE_MAX_RECORDS", 1, 10_000_000),
    port: integer(env.PORT, 3978, "PORT", 1, 65_535),
  };
}

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  TEAMS_BOT_APP_ID: "11111111-1111-4111-8111-111111111111",
  TEAMS_BOT_CLIENT_SECRET: "test-secret",
  TEAMS_BOT_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  TEAMS_ALLOWED_TENANT_IDS: "22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333",
  TEAMS_SSO_AUDIENCE: "api://11111111-1111-4111-8111-111111111111",
  TEAMS_SSO_CONNECTION_NAME: "teams-sso",
  OMNIGENT_ORIGIN: "https://omnigent.example",
  OMNIGENT_DEVICE_CLIENT_ID: "teams",
  TEAMS_GRANT_DATABASE: "/tmp/omnigent-teams-grants-test.sqlite3",
  TEAMS_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TEAMS_DEDUPE_DATABASE: "/tmp/omnigent-teams-test.sqlite3",
};

describe("loadConfig", () => {
  it("loads and normalizes strict Teams transport configuration", () => {
    const config = loadConfig({ ...validEnv, PORT: "4397" });

    expect(config.botAppId).toBe(validEnv.TEAMS_BOT_APP_ID);
    expect(config.allowedTenantIds).toEqual(new Set(validEnv.TEAMS_ALLOWED_TENANT_IDS.split(",")));
    expect(config.port).toBe(4397);
    expect(config.dedupeRetentionDays).toBeGreaterThanOrEqual(1);
    expect(config.dedupeMaxRecords).toBeGreaterThan(0);
    expect(config.tokenEncryptionKey).toEqual(Buffer.alloc(32, 7));
  });

  it.each([
    ["missing app ID", { TEAMS_BOT_APP_ID: undefined }],
    ["invalid app ID", { TEAMS_BOT_APP_ID: "not-a-guid" }],
    ["missing secret", { TEAMS_BOT_CLIENT_SECRET: "" }],
    ["missing app tenant", { TEAMS_BOT_TENANT_ID: undefined }],
    ["missing tenant allowlist", { TEAMS_ALLOWED_TENANT_IDS: "" }],
    ["invalid tenant allowlist", { TEAMS_ALLOWED_TENANT_IDS: "bad" }],
    [
      "duplicate tenant allowlist entries",
      {
        TEAMS_ALLOWED_TENANT_IDS:
          "22222222-2222-4222-8222-222222222222,22222222-2222-4222-8222-222222222222",
      },
    ],
    ["empty tenant allowlist entry", { TEAMS_ALLOWED_TENANT_IDS: `${validEnv.TEAMS_BOT_TENANT_ID},` }],
    ["invalid port", { PORT: "70000" }],
    ["missing SSO audience", { TEAMS_SSO_AUDIENCE: "" }],
    ["missing SSO connection", { TEAMS_SSO_CONNECTION_NAME: "" }],
    ["missing device client ID", { OMNIGENT_DEVICE_CLIENT_ID: "" }],
    ["invalid encryption key", { TEAMS_TOKEN_ENCRYPTION_KEY: "too-short" }],
    ["non-TLS Omnigent origin", { OMNIGENT_ORIGIN: "http://omnigent.example" }],
    ["Omnigent origin with credentials", { OMNIGENT_ORIGIN: "https://user:pass@omnigent.example" }],
    ["Omnigent origin with a path", { OMNIGENT_ORIGIN: "https://omnigent.example/api" }],
  ])("rejects %s", (_name, override) => {
    expect(() => loadConfig({ ...validEnv, ...override })).toThrow();
  });

  it("allows plain HTTP only for explicit loopback development", () => {
    const config = loadConfig({
      ...validEnv,
      OMNIGENT_ORIGIN: "http://127.0.0.1:8000",
      TEAMS_DEVELOPMENT_ALLOW_HTTP_LOOPBACK: "true",
    });
    expect(config.omnigentOrigin).toBe("http://127.0.0.1:8000");
  });
});

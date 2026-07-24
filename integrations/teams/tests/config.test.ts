import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  TEAMS_BOT_APP_ID: "11111111-1111-4111-8111-111111111111",
  TEAMS_BOT_CLIENT_SECRET: "test-secret",
  TEAMS_BOT_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  TEAMS_ALLOWED_TENANT_IDS: "22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333",
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
  ])("rejects %s", (_name, override) => {
    expect(() => loadConfig({ ...validEnv, ...override })).toThrow();
  });
});

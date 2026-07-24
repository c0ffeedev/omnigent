import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../appPackage/manifest.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("Teams app manifest", () => {
  it("is personal-only and requests no Microsoft Graph permissions", () => {
    const bots = manifest.bots as Array<Record<string, unknown>>;

    expect(manifest.id).toBe("${{TEAMS_APP_ID}}");
    expect(bots).toHaveLength(1);
    expect(bots[0].botId).toBe("${{BOT_APP_ID}}");
    expect(bots[0].scopes).toEqual(["personal"]);
    expect(manifest.validDomains).toEqual(["${{BOT_DOMAIN}}"]);
    expect(manifest).not.toHaveProperty("authorization");
  });
});

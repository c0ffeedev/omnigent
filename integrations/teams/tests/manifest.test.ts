import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../appPackage/manifest.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("Teams app manifest", () => {
  it("is personal-only and requests no Microsoft Graph permissions", () => {
    const bots = manifest.bots as Array<Record<string, unknown>>;
    const scopedCapabilities = [
      ...(manifest.bots as Array<Record<string, unknown>>),
      ...(manifest.staticTabs as Array<Record<string, unknown>>),
      ...((manifest.composeExtensions as Array<Record<string, unknown>> | undefined) ?? []),
      ...((manifest.configurableTabs as Array<Record<string, unknown>> | undefined) ?? []),
    ];

    expect(manifest.id).toBe("${{TEAMS_APP_ID}}");
    expect(bots).toHaveLength(1);
    expect(bots[0].botId).toBe("${{BOT_APP_ID}}");
    expect(scopedCapabilities).not.toHaveLength(0);
    for (const capability of scopedCapabilities) {
      expect(capability.scopes).toEqual(["personal"]);
    }
    expect(manifest.validDomains).toEqual(["${{BOT_DOMAIN}}"]);
    expect(manifest.permissions).toEqual(["identity"]);
    expect(manifest).not.toHaveProperty("authorization");
    expect(manifest.webApplicationInfo).toEqual({
      id: "${{BOT_APP_ID}}",
      resource: "api://${{BOT_DOMAIN}}/${{BOT_APP_ID}}",
    });
  });
});

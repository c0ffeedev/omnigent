import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ValidatedActivity } from "../src/activity.js";
import { EntraJwtValidator } from "../src/identity.js";

const tenantId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const audience = "api://11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

const activity: ValidatedActivity = {
  activity: {} as ValidatedActivity["activity"],
  activityId: "activity-1",
  botAppId: "11111111-1111-4111-8111-111111111111",
  channelSenderId: objectId,
  conversationId: "conversation-1",
  ok: true,
  senderId: objectId,
  tenantId,
};

function jwt(overrides: Record<string, unknown> = {}, key = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 300,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    nbf: Math.floor(now / 1000) - 1,
    oid: objectId,
    tid: tenantId,
    ver: "2.0",
    ...overrides,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

function validator(allowed = new Set([tenantId])): EntraJwtValidator {
  return new EntraJwtValidator({
    allowedTenantIds: allowed,
    audience,
    clock: () => now,
    fetch: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "key-1", use: "sig" }] }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  });
}

describe("EntraJwtValidator", () => {
  it("binds validated tid/oid claims to the signed Teams activity", async () => {
    await expect(validator().validate(jwt(), activity)).resolves.toEqual({ objectId, tenantId });
  });

  it.each([
    ["wrong audience", { aud: "api://other" }, activity],
    ["wrong issuer", { iss: "https://evil.example/issuer" }, activity],
    ["expired token", { exp: Math.floor(now / 1000) }, activity],
    ["wrong activity tenant", {}, { ...activity, tenantId: "44444444-4444-4444-8444-444444444444" }],
    ["wrong activity sender", {}, { ...activity, senderId: "44444444-4444-4444-8444-444444444444" }],
  ])("rejects %s", async (_name, claims, boundActivity) => {
    await expect(validator().validate(jwt(claims), boundActivity)).rejects.toThrow();
  });

  it("rejects a principal tenant outside the deployment allowlist", async () => {
    await expect(validator(new Set()).validate(jwt(), activity)).rejects.toThrow("not allowed");
  });

  it("rejects an invalid signature", async () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(validator().validate(jwt({}, attacker), activity)).rejects.toThrow("signature");
  });
});

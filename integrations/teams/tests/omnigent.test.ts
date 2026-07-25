import { describe, expect, it, vi } from "vitest";

import { OmnigentDeviceClient, OmnigentOAuthError } from "../src/omnigent.js";

function accessToken(grantId = "grant-1"): string {
  return ["header", Buffer.from(JSON.stringify({ grant_id: grantId })).toString("base64url"), "signature"].join(".");
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function client(fetcher: typeof fetch, overrides: Record<string, unknown> = {}): OmnigentDeviceClient {
  return new OmnigentDeviceClient({
    clientId: "teams-client",
    clientSecret: "device-secret",
    fetch: fetcher,
    origin: "https://omnigent.example",
    sleep: async () => {},
    ...overrides,
  });
}

describe("OmnigentDeviceClient", () => {
  it.each([
    ["header auth", json({ id: "proxy-user" }, 200)],
    ["OIDC", json({ login_url: "/auth/login" }, 401)],
    ["unknown", json({}, 401)],
  ])("rejects %s instead of guessing a server mode", async (_name, response) => {
    const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
    await expect(client(fetcher).assertAccountsMode()).rejects.toThrow("not in accounts mode");
  });

  it("starts only the accounts-mode interactive device flow and polls rotating tokens", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    let tokenPoll = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ init, input: String(input) });
      if (String(input).endsWith("/v1/me")) return json({ login_url: "/login" }, 401);
      if (String(input).endsWith("/oauth/device/authorize")) {
        return json({
          device_code: "device-code",
          expires_in: 600,
          interval: 1,
          user_code: "ABCD",
          verification_uri_complete: "https://omnigent.example/activate?code=ABCD",
        });
      }
      tokenPoll += 1;
      if (tokenPoll === 1) return json({ error: "authorization_pending" }, 400);
      return json({
        access_token: accessToken(),
        expires_in: 3600,
        refresh_token: "rotated-refresh",
      });
    }) as unknown as typeof fetch;

    const pending = await client(fetcher).startLogin();
    expect(pending.verificationUrl).toContain("/activate");
    await expect(pending.poll()).resolves.toMatchObject({
      grantId: "grant-1",
      refreshToken: "rotated-refresh",
    });
    expect(requests.every(({ init }) => init?.redirect === "manual")).toBe(true);
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ client_id: "teams-client", scope: "interactive" }));
    expect(String(requests[2]?.init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect((requests[1]!.init!.headers as Record<string, string>)["x-omnigent-client-secret"]).toBe("device-secret");
  });

  it("rejects a verification URL outside the operator-configured origin", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/me")) return json({ login_url: "/login" }, 401);
      return json({
        device_code: "device-code",
        expires_in: 600,
        interval: 1,
        user_code: "ABCD",
        verification_uri_complete: "https://evil.example/activate?code=ABCD",
      });
    }) as unknown as typeof fetch;

    await expect(client(fetcher).startLogin()).rejects.toThrow("verification URL");
  });

  it("rejects redirects without following them", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      headers: { location: "https://evil.example/steal" },
      status: 302,
    })) as unknown as typeof fetch;
    await expect(client(fetcher).assertAccountsMode()).rejects.toThrow("redirects are not accepted");
    expect(fetcher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: "manual" }));
  });

  it("marks transport failures as uncertain refresh outcomes", async () => {
    const fetcher = vi.fn(async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
    const error = await client(fetcher).refresh("refresh-canary").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmnigentOAuthError);
    expect((error as OmnigentOAuthError).outcomeMayBeUncertain).toBe(true);
    expect(String(error)).not.toContain("refresh-canary");
  });

  it("treats server errors as uncertain but a signed invalid_grant response as definitive", async () => {
    const uncertain = await client(vi.fn(async () => json({ error: "server_error" }, 500)) as unknown as typeof fetch)
      .refresh("refresh-canary")
      .catch((caught: unknown) => caught);
    const rejected = await client(vi.fn(async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch)
      .refresh("refresh-canary")
      .catch((caught: unknown) => caught);

    expect(uncertain).toBeInstanceOf(OmnigentOAuthError);
    expect((uncertain as OmnigentOAuthError).outcomeMayBeUncertain).toBe(true);
    expect(rejected).toBeInstanceOf(OmnigentOAuthError);
    expect((rejected as OmnigentOAuthError).outcomeMayBeUncertain).toBe(false);
  });
});

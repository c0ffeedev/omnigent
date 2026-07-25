import type { GrantTokens } from "./grants.js";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const INTERACTIVE_SCOPE = "interactive";

export class OmnigentOAuthError extends Error {
  constructor(message: string, readonly outcomeMayBeUncertain = true) {
    super(message);
    this.name = "OmnigentOAuthError";
  }
}

export interface PendingDeviceLogin {
  verificationUrl: string;
  userCode: string;
  poll(): Promise<GrantTokens>;
}

export interface DeviceClientOptions {
  origin: string;
  clientId: string;
  clientSecret?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown, fallback?: number): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
    throw new OmnigentOAuthError("Omnigent OAuth response is malformed");
  }
  return candidate;
}

function grantId(accessToken: string): string {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new OmnigentOAuthError("Omnigent access token is malformed");
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const id = string(payload.grant_id);
    if (!id) throw new Error();
    return id;
  } catch {
    throw new OmnigentOAuthError("Omnigent access token has no grant identifier");
  }
}

function tokens(body: unknown): GrantTokens {
  const value = object(body);
  const accessToken = string(value?.access_token);
  const refreshToken = string(value?.refresh_token);
  if (!accessToken || !refreshToken) throw new OmnigentOAuthError("Omnigent token response is malformed");
  return {
    accessToken,
    expiresIn: positiveInteger(value?.expires_in, 3600),
    grantId: grantId(accessToken),
    refreshToken,
  };
}

export class OmnigentDeviceClient {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(private readonly options: DeviceClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.clock = options.clock ?? Date.now;
  }

  private headers(contentType?: string): HeadersInit {
    return {
      accept: "application/json",
      ...(contentType ? { "content-type": contentType } : {}),
      ...(this.options.clientSecret ? { "x-omnigent-client-secret": this.options.clientSecret } : {}),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.options.origin}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new OmnigentOAuthError("Omnigent OAuth request failed", true);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OmnigentOAuthError("Omnigent OAuth redirects are not accepted", true);
    }
    return response;
  }

  async assertAccountsMode(): Promise<void> {
    const response = await this.request("/v1/me", { headers: this.headers(), method: "GET" });
    if (response.status !== 401) throw new OmnigentOAuthError("Omnigent server is not in accounts mode");
    let body: Record<string, unknown> | undefined;
    try {
      body = object(await response.json());
    } catch {
      throw new OmnigentOAuthError("Omnigent auth-mode response is malformed");
    }
    if (body?.login_url !== "/login") {
      throw new OmnigentOAuthError("Omnigent server is not in accounts mode");
    }
  }

  async startLogin(): Promise<PendingDeviceLogin> {
    await this.assertAccountsMode();
    const response = await this.request("/oauth/device/authorize", {
      body: JSON.stringify({ client_id: this.options.clientId, scope: INTERACTIVE_SCOPE }),
      headers: this.headers("application/json"),
      method: "POST",
    });
    if (!response.ok) throw new OmnigentOAuthError(`Could not start Omnigent login (HTTP ${response.status})`);
    const body = object(await response.json());
    const deviceCode = string(body?.device_code);
    const verificationUrl = string(body?.verification_uri_complete);
    if (!deviceCode || !verificationUrl) throw new OmnigentOAuthError("Omnigent device authorization response is malformed");
    let verificationOrigin: string;
    try {
      const url = new URL(verificationUrl);
      if (url.username || url.password) throw new Error();
      verificationOrigin = url.origin;
    } catch {
      throw new OmnigentOAuthError("Omnigent verification URL is invalid");
    }
    if (verificationOrigin !== new URL(this.options.origin).origin) {
      throw new OmnigentOAuthError("Omnigent verification URL has an unexpected origin");
    }
    let interval = positiveInteger(body?.interval, 5);
    const expiresIn = positiveInteger(body?.expires_in, 600);
    const deadline = this.clock() + expiresIn * 1000;
    return {
      poll: async () => {
        while (this.clock() < deadline) {
          await this.sleep(interval * 1000);
          const tokenResponse = await this.request("/oauth/token", {
            body: new URLSearchParams({ device_code: deviceCode, grant_type: DEVICE_GRANT_TYPE }).toString(),
            headers: this.headers("application/x-www-form-urlencoded"),
            method: "POST",
          });
          if (tokenResponse.status === 200) return tokens(await tokenResponse.json());
          let error: unknown;
          try {
            error = object(await tokenResponse.json())?.error;
          } catch {
            error = undefined;
          }
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            interval += 1;
            continue;
          }
          if (error === "access_denied") throw new OmnigentOAuthError("Omnigent login was denied");
          if (error === "expired_token") throw new OmnigentOAuthError("Omnigent login expired");
          throw new OmnigentOAuthError(`Omnigent login failed (${String(error ?? tokenResponse.status)})`);
        }
        throw new OmnigentOAuthError("Omnigent login expired");
      },
      userCode: string(body?.user_code) ?? "",
      verificationUrl,
    };
  }

  async refresh(refreshToken: string): Promise<GrantTokens> {
    const response = await this.request("/oauth/token", {
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      headers: this.headers("application/x-www-form-urlencoded"),
      method: "POST",
    });
    if (response.status !== 200) {
      let oauthError: unknown;
      try {
        oauthError = object(await response.json())?.error;
      } catch {
        oauthError = undefined;
      }
      const definitivelyRejected = response.status === 400 && oauthError === "invalid_grant";
      throw new OmnigentOAuthError(
        `Omnigent refresh failed (HTTP ${response.status})`,
        !definitivelyRejected,
      );
    }
    try {
      return tokens(await response.json());
    } catch {
      throw new OmnigentOAuthError("Omnigent refresh response is malformed", true);
    }
  }

  async revoke(refreshToken: string): Promise<boolean> {
    const response = await this.request("/oauth/revoke", {
      body: new URLSearchParams({ refresh_token: refreshToken }).toString(),
      headers: this.headers("application/x-www-form-urlencoded"),
      method: "POST",
    });
    return response.ok;
  }
}

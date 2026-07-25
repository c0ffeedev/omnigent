import { createPublicKey, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";

import type { ValidatedActivity } from "./activity.js";

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface JwtClaims {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  nbf?: unknown;
  oid?: unknown;
  tid?: unknown;
  ver?: unknown;
}

interface JsonWebKeySet {
  keys?: EntraJsonWebKey[];
}

interface EntraJsonWebKey extends CryptoJsonWebKey {
  kid?: string;
}

export interface EntraPrincipal {
  tenantId: string;
  objectId: string;
}

export interface EntraJwtValidatorOptions {
  audience: string;
  allowedTenantIds: ReadonlySet<string>;
  fetch?: typeof fetch;
  jwksUrl?: string;
  clock?: () => number;
  cacheMilliseconds?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";

function decodeSegment<T>(value: string, name: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`invalid Entra JWT ${name}`);
  }
}

function exactUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value.toLowerCase())) {
    throw new Error(`Entra JWT ${name} claim is invalid`);
  }
  return value.toLowerCase();
}

export class EntraJwtValidator {
  private readonly fetcher: typeof fetch;
  private readonly jwksUrl: string;
  private readonly clock: () => number;
  private readonly cacheMilliseconds: number;
  private keys = new Map<string, EntraJsonWebKey>();
  private keysExpiresAt = 0;

  constructor(private readonly options: EntraJwtValidatorOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.jwksUrl = options.jwksUrl ?? DEFAULT_JWKS_URL;
    this.clock = options.clock ?? Date.now;
    this.cacheMilliseconds = options.cacheMilliseconds ?? 60 * 60 * 1000;
    if (!options.audience.trim()) throw new Error("Entra SSO audience is required");
  }

  private async refreshKeys(): Promise<void> {
    const response = await this.fetcher(this.jwksUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("unable to load Entra signing keys");
    const body = await response.json() as JsonWebKeySet;
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error("Entra signing key response is invalid");
    }
    const next = new Map<string, EntraJsonWebKey>();
    for (const key of body.keys) {
      if (typeof key.kid === "string" && key.kty === "RSA" && key.use === "sig") next.set(key.kid, key);
    }
    if (next.size === 0) throw new Error("Entra signing key response has no usable keys");
    this.keys = next;
    this.keysExpiresAt = this.clock() + this.cacheMilliseconds;
  }

  private async signingKey(kid: string): Promise<EntraJsonWebKey> {
    if (this.clock() >= this.keysExpiresAt || !this.keys.has(kid)) await this.refreshKeys();
    const key = this.keys.get(kid);
    if (!key) throw new Error("Entra JWT signing key is unknown");
    return key;
  }

  async validate(token: string, activity: ValidatedActivity): Promise<EntraPrincipal> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("invalid Entra JWT structure");
    const header = decodeSegment<JwtHeader>(parts[0]!, "header");
    const claims = decodeSegment<JwtClaims>(parts[1]!, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
      throw new Error("unsupported Entra JWT signing parameters");
    }
    const key = await this.signingKey(header.kid);
    const validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ format: "jwk", key }),
      Buffer.from(parts[2]!, "base64url"),
    );
    if (!validSignature) throw new Error("Entra JWT signature is invalid");

    const tenantId = exactUuid(claims.tid, "tid");
    const objectId = exactUuid(claims.oid, "oid");
    const now = Math.floor(this.clock() / 1000);
    if (claims.ver !== "2.0") throw new Error("Entra JWT version is invalid");
    if (claims.aud !== this.options.audience) throw new Error("Entra JWT audience is invalid");
    if (claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) {
      throw new Error("Entra JWT issuer is invalid");
    }
    if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now) {
      throw new Error("Entra JWT is expired");
    }
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) {
      throw new Error("Entra JWT is not active");
    }
    if (!this.options.allowedTenantIds.has(tenantId)) throw new Error("Entra tenant is not allowed");
    if (tenantId !== activity.tenantId || objectId !== activity.senderId) {
      throw new Error("Entra principal does not match the signed Teams activity");
    }
    return { objectId, tenantId };
  }
}

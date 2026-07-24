import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PUBLIC } from "@microsoft/teams.api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTeamsApp, type TeamsAppOptions } from "../src/app.js";
import { HELP_TEXT } from "../src/activity.js";
import type { TeamsConfig } from "../src/config.js";
import { ActivityDedupeStore } from "../src/dedupe.js";

const appId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issuer = "https://api.botframework.com";
const serviceUrl = "https://smba.trafficmanager.net/amer/";
const kid = "mock-channel-key";
const directory = mkdtempSync(join(tmpdir(), "omnigent-teams-ingress-"));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
let server: Server;
let baseUrl: string;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(claims: Record<string, unknown> = {}, signingKey = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({
    aud: appId,
    iss: issuer,
    serviceurl: serviceUrl,
    sub: "mock-channel",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...claims,
  })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), signingKey).toString("base64url")}`;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    type: "event",
    id: `activity-${Math.random()}`,
    channelId: "msteams",
    serviceUrl,
    from: { id: "sender-1", aadObjectId: objectId },
    recipient: { id: `28:${appId}` },
    conversation: { id: "conversation-1", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId } },
    ...overrides,
  };
}

const config: TeamsConfig = {
  botAppId: appId,
  botClientSecret: "test-secret",
  botTenantId: tenantId,
  allowedTenantIds: new Set([tenantId]),
  dedupeDatabase: join(directory, "dedupe.sqlite3"),
  dedupeRetentionDays: 7,
  dedupeMaxRecords: 100,
  port: 3978,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/keys") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock JWKS server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(directory, { force: true, recursive: true });
});

async function request(
  authToken: string | undefined,
  activity = body(),
  client?: NonNullable<TeamsAppOptions["client"]>,
  logger?: TeamsAppOptions["logger"],
) {
  const dedupe = new ActivityDedupeStore(config.dedupeDatabase, {
    maxRecords: config.dedupeMaxRecords,
    retentionDays: config.dedupeRetentionDays,
  });
  const app = createTeamsApp(config, dedupe, {
    cloud: {
      ...PUBLIC,
      openIdMetadataUrl: `${baseUrl}/openidconfiguration`,
      tokenIssuer: issuer,
    },
    client,
    logger,
  });
  await app.initialize();
  try {
    return await app.server.handleRequest({
      body: activity,
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    });
  } finally {
    dedupe.close();
  }
}

interface MockChannelRequest {
  data: unknown;
  url: string;
}

function mockedChannel(
  requests: MockChannelRequest[],
  options: { failPost?: boolean } = {},
): NonNullable<TeamsAppOptions["client"]> {
  const response = (data: unknown) => ({
    config: {},
    data,
    headers: {},
    status: 200,
    statusText: "OK",
  });
  const client = {
    clone: () => client,
    delete: async () => response({}),
    get: async () => response({}),
    patch: async () => response({}),
    post: async (url: string, data: unknown) => {
      requests.push({ data, url });
      if (options.failPost) throw new Error("mock Teams send failed");
      return response({ id: "reply-1" });
    },
    put: async () => response({}),
    request: async () => response({}),
  };
  return client as unknown as NonNullable<TeamsAppOptions["client"]>;
}

describe("authenticated Teams ingress", () => {
  it("accepts a correctly signed mocked Bot Framework channel activity", async () => {
    expect(await request(token())).toMatchObject({ status: 200 });
  });

  it("sends the bounded static help reply through authenticated SDK message ingress exactly once", async () => {
    const id = `message-${Math.random()}`;
    const requests: MockChannelRequest[] = [];
    const channel = mockedChannel(requests);
    const message = body({ id, text: "help", type: "message" });

    expect(await request(token(), message, channel)).toMatchObject({ status: 200 });
    expect(await request(token(), message, channel)).toMatchObject({ status: 200 });

    expect(requests).toHaveLength(1);
    const sentRequest = requests[0]!;
    expect(sentRequest.url).toContain("/v3/conversations/conversation-1/activities");
    expect(sentRequest.data).toMatchObject({ type: "message" });
    const wireText = (sentRequest.data as { text?: string }).text;
    expect(wireText?.replace(/^<quoted messageId="[^"]+"\/>\s*/, "")).toBe(HELP_TEXT);
    expect(wireText?.length).toBeLessThanOrEqual(500);
    expect(HELP_TEXT.length).toBeLessThanOrEqual(500);
    const persisted = new ActivityDedupeStore(config.dedupeDatabase, {
      maxRecords: config.dedupeMaxRecords,
      retentionDays: config.dedupeRetentionDays,
    });
    expect(persisted.get({
      activityId: id,
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: objectId,
      tenantId,
    })).toMatchObject({ receipt: "reply-1", state: "delivered" });
    expect(persisted.count()).toBe(1);
    persisted.close();
  });

  it("retries a failed SDK reply after process restart instead of swallowing help", async () => {
    const id = `retry-${Math.random()}`;
    const message = body({ id, text: "help", type: "message" });
    const failedRequests: MockChannelRequest[] = [];

    expect((await request(token(), message, mockedChannel(failedRequests, { failPost: true }))).status)
      .toBeGreaterThanOrEqual(500);

    const retriedRequests: MockChannelRequest[] = [];
    expect(await request(token(), message, mockedChannel(retriedRequests))).toMatchObject({ status: 200 });
    expect(failedRequests).toHaveLength(1);
    expect(retriedRequests).toHaveLength(1);

    const persisted = new ActivityDedupeStore(config.dedupeDatabase, {
      maxRecords: config.dedupeMaxRecords,
      retentionDays: config.dedupeRetentionDays,
    });
    expect(persisted.get({
      activityId: id,
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: objectId,
      tenantId,
    })).toMatchObject({ attemptCount: 2, receipt: "reply-1", state: "delivered" });
    persisted.close();
  });

  it.each([
    ["missing token", undefined],
    ["wrong audience/app ID", token({ aud: "44444444-4444-4444-8444-444444444444" })],
    ["wrong issuer", token({ iss: "https://attacker.invalid" })],
    ["wrong service URL", token({ serviceurl: "https://attacker.invalid" })],
  ])("rejects %s", async (_name, authToken) => {
    expect(await request(authToken)).toMatchObject({ status: 401 });
  });

  it("rejects an invalid signature", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await request(token({}, other.privateKey))).toMatchObject({ status: 401 });
  });

  it.each([
    ["missing activity type", body({ type: undefined })],
    ["missing service URL", body({ serviceUrl: undefined })],
    ["missing conversation tenant", body({ conversation: { id: "conversation-1", conversationType: "personal" } })],
    ["missing channel tenant", body({ channelData: {} })],
    ["disallowed tenant", body({ conversation: { id: "conversation-1", conversationType: "personal", tenantId: "33333333-3333-4333-8333-333333333333" }, channelData: { tenant: { id: "33333333-3333-4333-8333-333333333333" } } })],
    ["group scope", body({ conversation: { id: "conversation-1", conversationType: "groupChat", tenantId } })],
    ["wrong recipient app", body({ recipient: { id: "28:44444444-4444-4444-8444-444444444444" } })],
    ["missing sender identity", body({ from: { id: "sender-1" } })],
    ["malformed sender object ID", body({ from: { id: "sender-1", aadObjectId: "not-a-guid" } })],
    ["unprefixed recipient app", body({ recipient: { id: appId } })],
  ])("fails closed for %s", async (_name, activity) => {
    expect((await request(token(), activity)).status).toBeGreaterThanOrEqual(400);
  });

  it("does not accept authorization from forwarding headers", async () => {
    const dedupe = new ActivityDedupeStore(config.dedupeDatabase, {
      maxRecords: config.dedupeMaxRecords,
      retentionDays: config.dedupeRetentionDays,
    });
    const app = createTeamsApp(config, dedupe, {
      cloud: {
        ...PUBLIC,
        openIdMetadataUrl: `${baseUrl}/openidconfiguration`,
        tokenIssuer: issuer,
      },
    });
    await app.initialize();
    try {
      expect(await app.server.handleRequest({
        body: body(),
        headers: { "x-forwarded-authorization": `Bearer ${token()}` },
      })).toMatchObject({ status: 401 });
    } finally {
      dedupe.close();
    }
  });

  it("redacts activity bodies and credentials from SDK log arguments", async () => {
    const entries: unknown[][] = [];
    const logger: NonNullable<TeamsAppOptions["logger"]> = {
      child: () => logger,
      debug: (...args: unknown[]) => entries.push(args),
      error: (...args: unknown[]) => entries.push(args),
      info: (...args: unknown[]) => entries.push(args),
      log: (_level, ...args: unknown[]) => entries.push(args),
      trace: (...args: unknown[]) => entries.push(args),
      warn: (...args: unknown[]) => entries.push(args),
    };
    const marker = "sensitive-message-marker";
    const credential = token();

    await request(credential, body({ text: marker }), undefined, logger);

    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(credential);
  });
});

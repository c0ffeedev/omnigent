import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GrantStore, type GrantTokens, type PrincipalKey } from "../src/grants.js";

const key: PrincipalKey = {
  botAppId: "11111111-1111-4111-8111-111111111111",
  objectId: "33333333-3333-4333-8333-333333333333",
  omnigentOrigin: "https://omnigent.example",
  tenantId: "22222222-2222-4222-8222-222222222222",
};
const token: GrantTokens = {
  accessToken: "access-token-cleartext-canary",
  expiresIn: 3600,
  grantId: "grant-1",
  refreshToken: "refresh-token-cleartext-canary",
};
let directory: string | undefined;

async function store(options: { refreshLeaseMilliseconds?: number } = {}): Promise<{ path: string; store: GrantStore }> {
  directory = await mkdtemp(join(tmpdir(), "omnigent-teams-grants-"));
  const path = join(directory, "grants.sqlite3");
  return {
    path,
    store: new GrantStore(path, Buffer.alloc(32, 9), { maximumLifetimeDays: 30, ...options }),
  };
}

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("GrantStore", () => {
  it("encrypts token material and scopes lookups to the exact principal tuple", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    expect(fixture.store.active(key, 2_000)).toMatchObject({
      accessToken: token.accessToken,
      grantId: token.grantId,
      refreshToken: token.refreshToken,
    });
    expect(fixture.store.active({ ...key, objectId: "44444444-4444-4444-8444-444444444444" }, 2_000)).toBeUndefined();
    expect(fixture.store.active({ ...key, omnigentOrigin: "https://other.example" }, 2_000)).toBeUndefined();
    const bytes = Buffer.concat(
      readdirSync(directory!).map((name) => readFileSync(join(directory!, name))),
    );
    expect(bytes.includes(Buffer.from(token.accessToken))).toBe(false);
    expect(bytes.includes(Buffer.from(token.refreshToken))).toBe(false);
    fixture.store.close();
  });

  it("relinks atomically and queues the superseded grant for revocation", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    const replacement = fixture.store.link(key, {
      ...token,
      accessToken: "access-2",
      grantId: "grant-2",
      refreshToken: "refresh-2",
    }, 2_000);

    expect(replacement).toMatchObject({ generation: 2, grantId: "grant-2" });
    expect(fixture.store.pendingRevocations(2_000)).toHaveLength(1);
    expect(fixture.store.pendingRevocations(2_000)[0]?.refreshToken).toBe(token.refreshToken);
    fixture.store.close();
  });

  it("immediately retires the prior grant across stores and fences a cancelled relink", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    const attempt = fixture.store.beginConnect(key, 2_000);
    fixture.store.close();

    const reopened = new GrantStore(fixture.path, Buffer.alloc(32, 9), { maximumLifetimeDays: 30 });
    expect(reopened.active(key, 2_000)).toBeUndefined();
    expect(reopened.pendingRevocations(2_000)).toMatchObject([{ refreshToken: token.refreshToken }]);

    expect(reopened.cancelConnect(key, attempt, 3_000)).toBe(true);
    expect(reopened.completeConnect(key, attempt, {
      ...token,
      grantId: "cancelled-grant",
      refreshToken: "cancelled-refresh",
    }, 4_000)).toBeUndefined();
    expect(reopened.active(key, 4_000)).toBeUndefined();
    expect(reopened.pendingRevocations(4_000).map(({ refreshToken }) => refreshToken).sort())
      .toEqual(["cancelled-refresh", token.refreshToken].sort());
    reopened.close();
  });

  it("keeps the newest connect when device approvals complete out of order", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    const older = fixture.store.beginConnect(key, 2_000);
    const otherWorker = new GrantStore(fixture.path, Buffer.alloc(32, 9), { maximumLifetimeDays: 30 });
    expect(otherWorker.active(key, 2_000)).toBeUndefined();
    expect(otherWorker.pendingRevocations(2_000)).toMatchObject([{ refreshToken: token.refreshToken }]);
    const newer = otherWorker.beginConnect(key, 3_000);
    const replacement = { ...token, grantId: "grant-2", refreshToken: "refresh-2" };
    const stale = { ...token, grantId: "stale-grant", refreshToken: "stale-refresh" };

    expect(otherWorker.completeConnect(key, newer, replacement, 4_000)).toMatchObject({ grantId: "grant-2" });
    expect(fixture.store.completeConnect(key, older, stale, 5_000)).toBeUndefined();
    expect(otherWorker.active(key, 5_000)).toMatchObject({ grantId: "grant-2", refreshToken: "refresh-2" });
    expect(otherWorker.pendingRevocations(5_000).map(({ refreshToken }) => refreshToken).sort())
      .toEqual(["stale-refresh", token.refreshToken].sort());
    otherWorker.close();
    fixture.store.close();
  });

  it("keeps generations monotonic across logout and relink", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.logout(key, 2_000);

    const relinked = fixture.store.link(key, {
      ...token,
      grantId: "grant-2",
      refreshToken: "refresh-2",
    }, 3_000);

    expect(relinked.generation).toBe(2);
    fixture.store.close();
  });

  it("disables locally before best-effort remote revocation", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    expect(fixture.store.logout(key, 2_000)).toBe(true);
    expect(fixture.store.active(key, 2_000)).toBeUndefined();
    expect(fixture.store.status(key, 2_000)).toEqual({ state: "not_connected" });
    expect(fixture.store.pendingRevocations(2_000)).toHaveLength(1);
    fixture.store.close();
  });

  it("serializes refresh rotation and advances the generation with compare-and-swap", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    expect(fixture.store.acquireRefresh(key, "worker-a", 1, 2_000).status).toBe("acquired");
    expect(fixture.store.acquireRefresh(key, "worker-b", 1, 2_000).status).toBe("busy");

    const refreshed = fixture.store.commitRefresh(key, "worker-a", 1, {
      ...token,
      accessToken: "access-2",
      grantId: "grant-2",
      refreshToken: "refresh-2",
    }, 3_000);
    expect(refreshed).toMatchObject({ generation: 2, refreshToken: "refresh-2" });
    expect(fixture.store.acquireRefresh(key, "worker-b", 1, 3_000)).toMatchObject({
      status: "already_refreshed",
    });
    fixture.store.close();
  });

  it("rejects malformed rotation results without replacing the active generation", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.acquireRefresh(key, "worker-a", 1, 2_000);

    expect(() => fixture.store.commitRefresh(key, "worker-a", 1, {
      ...token,
      expiresIn: 0,
      refreshToken: "",
    }, 3_000)).toThrow("grant token response is invalid");
    expect(fixture.store.active(key, 3_000)).toMatchObject({ generation: 1 });
    fixture.store.close();
  });

  it("never replays an old refresh token after an abandoned exchange lease", async () => {
    const fixture = await store({ refreshLeaseMilliseconds: 10 });
    fixture.store.link(key, token, 1_000);
    fixture.store.acquireRefresh(key, "crashed-worker", 1, 2_000);

    expect(() => fixture.store.acquireRefresh(key, "replacement-worker", 1, 2_011)).toThrow("uncertain");
    expect(fixture.store.status(key, 2_011)).toMatchObject({
      reason: "refresh_outcome_uncertain",
      state: "relink_required",
    });
    expect(fixture.store.pendingRevocations(2_011)).toHaveLength(1);
    fixture.store.close();
  });

  it("disables the consumed binding and queues both token generations when refresh commit loses CAS", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.acquireRefresh(key, "worker-a", 1, 2_000);

    expect(() => fixture.store.commitRefresh(key, "wrong-owner", 1, {
      ...token,
      accessToken: "access-2",
      grantId: "grant-2",
      refreshToken: "refresh-2",
    }, 3_000)).toThrow("generation fence");
    expect(fixture.store.active(key, 3_000)).toBeUndefined();
    expect(fixture.store.pendingRevocations(3_000).map(({ refreshToken }) => refreshToken).sort())
      .toEqual(["refresh-2", token.refreshToken].sort());
    fixture.store.close();
  });

  it("does not revoke a replacement binding when an older refresh result arrives late", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.acquireRefresh(key, "worker-a", 1, 2_000);
    const replacement = fixture.store.link(key, {
      ...token,
      accessToken: "replacement-access",
      grantId: "replacement-grant",
      refreshToken: "replacement-refresh",
    }, 2_500);

    expect(() => fixture.store.commitRefresh(key, "worker-a", 1, {
      ...token,
      accessToken: "late-access",
      grantId: "late-grant",
      refreshToken: "late-refresh",
    }, 3_000)).toThrow("generation fence");
    expect(fixture.store.active(key, 3_000)).toMatchObject({
      generation: replacement.generation,
      grantId: "replacement-grant",
      refreshToken: "replacement-refresh",
    });
    expect(fixture.store.pendingRevocations(3_000).map(({ refreshToken }) => refreshToken).sort())
      .toEqual(["late-refresh", token.refreshToken].sort());
    fixture.store.close();
  });

  it("does not disable a replacement binding when an older refresh is rejected", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.acquireRefresh(key, "worker-a", 1, 2_000);
    const replacement = fixture.store.link(key, {
      ...token,
      accessToken: "replacement-access",
      grantId: "replacement-grant",
      refreshToken: "replacement-refresh",
    }, 2_500);

    fixture.store.rejectRefresh(key, "worker-a", 1, 3_000);

    expect(fixture.store.active(key, 3_000)).toMatchObject({
      generation: replacement.generation,
      grantId: "replacement-grant",
    });
    fixture.store.close();
  });

  it("retains revocation tombstones across restart and erases them at maximum lifetime", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.logout(key, 2_000);
    fixture.store.close();

    const reopened = new GrantStore(fixture.path, Buffer.alloc(32, 9), { maximumLifetimeDays: 30 });
    expect(reopened.pendingRevocations(2_000)).toHaveLength(1);
    const maximumLifetime = 1_000 + 30 * 24 * 60 * 60 * 1000;
    expect(reopened.pendingRevocations(maximumLifetime)).toHaveLength(0);
    expect(reopened.status(key, maximumLifetime)).toEqual({ state: "not_connected" });
    reopened.close();
  });

  it("backs off repeated revocation attempts with a bounded retry delay", async () => {
    const fixture = await store();
    fixture.store.link(key, token, 1_000);
    fixture.store.logout(key, 2_000);
    const id = fixture.store.pendingRevocations(2_000)[0]!.id;

    fixture.store.deferRevocation(id, 2_000);
    expect(fixture.store.pendingRevocations(61_999)).toHaveLength(0);
    expect(fixture.store.pendingRevocations(62_000)).toHaveLength(1);
    fixture.store.deferRevocation(id, 62_000);
    expect(fixture.store.pendingRevocations(181_999)).toHaveLength(0);
    expect(fixture.store.pendingRevocations(182_000)).toHaveLength(1);
    fixture.store.close();
  });

  it("enforces the configured maximum grant lifetime", async () => {
    const fixture = await store();
    const linked = fixture.store.link(key, token, 1_000);
    expect(fixture.store.status(key, linked.grantExpiresAt)).toMatchObject({
      reason: "maximum_lifetime_exceeded",
      state: "relink_required",
    });
    fixture.store.close();
  });

  it("does not expire a replacement observed through another store connection", async () => {
    const fixture = await store();
    const first = fixture.store.link(key, token, 1_000);
    const otherWorker = new GrantStore(fixture.path, Buffer.alloc(32, 9), { maximumLifetimeDays: 30 });
    const replacement = otherWorker.link(key, {
      ...token,
      grantId: "replacement-grant",
      refreshToken: "replacement-refresh",
    }, first.grantExpiresAt - 1);

    expect(fixture.store.status(key, first.grantExpiresAt)).toMatchObject({
      generation: replacement.generation,
      grantId: "replacement-grant",
      state: "connected",
    });
    expect(otherWorker.active(key, first.grantExpiresAt)).toMatchObject({
      grantId: "replacement-grant",
    });
    otherWorker.close();
    fixture.store.close();
  });
});

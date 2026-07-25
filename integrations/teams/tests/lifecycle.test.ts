import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GrantStore, type GrantTokens } from "../src/grants.js";
import type { EntraPrincipal } from "../src/identity.js";
import { GrantLifecycle } from "../src/lifecycle.js";
import { OmnigentOAuthError, type OmnigentDeviceClient } from "../src/omnigent.js";

const appId = "11111111-1111-4111-8111-111111111111";
const omnigentOrigin = "https://omnigent.example";
const principal: EntraPrincipal = {
  objectId: "33333333-3333-4333-8333-333333333333",
  tenantId: "22222222-2222-4222-8222-222222222222",
};
const tokens: GrantTokens = {
  accessToken: "access-1",
  expiresIn: 3600,
  grantId: "grant-1",
  refreshToken: "refresh-1",
};
let directory: string | undefined;

function openStore(path: string): GrantStore {
  return new GrantStore(path, Buffer.alloc(32, 4), { maximumLifetimeDays: 30 });
}

async function fixture(client: Partial<OmnigentDeviceClient>): Promise<{
  lifecycle: GrantLifecycle;
  path: string;
  store: GrantStore;
}> {
  directory = await mkdtemp(join(tmpdir(), "omnigent-teams-lifecycle-"));
  const path = join(directory, "grants.sqlite3");
  const store = openStore(path);
  return {
    lifecycle: new GrantLifecycle(appId, omnigentOrigin, store, client as OmnigentDeviceClient),
    path,
    store,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("GrantLifecycle", () => {
  it("links the completed device flow to only the validated Entra principal", async () => {
    const test = await fixture({
      startLogin: vi.fn(async () => ({
        poll: async () => tokens,
        userCode: "ABCD",
        verificationUrl: "https://omnigent.example/activate",
      })),
    });

    const connected = await test.lifecycle.connect(principal);
    expect(connected.message).toContain("https://omnigent.example/activate");
    await expect(connected.completion).resolves.toContain("connected");
    expect(test.lifecycle.status(principal)).toContain("connected");
    expect(test.lifecycle.status({ ...principal, objectId: "44444444-4444-4444-8444-444444444444" })).toContain("No Omnigent");
    test.store.close();
  });

  it("keeps prior authority retired after a relink device flow fails", async () => {
    const test = await fixture({
      startLogin: vi.fn(async () => ({
        poll: async () => { throw new Error("device flow failed"); },
        userCode: "ABCD",
        verificationUrl: "https://omnigent.example/activate",
      })),
    });
    test.store.link(test.lifecycle.key(principal), tokens);

    const pending = await test.lifecycle.connect(principal);
    await expect(pending.completion).resolves.toContain("connection failed");
    const otherStore = openStore(test.path);
    expect(otherStore.active(test.lifecycle.key(principal))).toBeUndefined();
    expect(otherStore.pendingRevocations()).toMatchObject([{ refreshToken: tokens.refreshToken }]);
    expect(otherStore.completeConnect(test.lifecycle.key(principal), 1, {
      ...tokens,
      grantId: "late-grant",
      refreshToken: "late-refresh",
    })).toBeUndefined();
    expect(otherStore.active(test.lifecycle.key(principal))).toBeUndefined();
    expect(otherStore.pendingRevocations().map(({ refreshToken }) => refreshToken).sort())
      .toEqual(["late-refresh", tokens.refreshToken].sort());
    otherStore.close();
    test.store.close();
  });

  it("does not restore authority when another worker logs out before device approval", async () => {
    let finish!: (value: GrantTokens) => void;
    const test = await fixture({
      startLogin: vi.fn(async () => ({
        poll: () => new Promise<GrantTokens>((resolve) => { finish = resolve; }),
        userCode: "ABCD",
        verificationUrl: "https://omnigent.example/activate",
      })),
    });

    const pending = await test.lifecycle.connect(principal);
    const otherStore = openStore(test.path);
    const otherWorker = new GrantLifecycle(appId, omnigentOrigin, otherStore, {} as OmnigentDeviceClient);
    expect(otherWorker.logout(principal)).toContain("disconnected locally");
    finish(tokens);
    await expect(pending.completion).resolves.toContain("cancelled or replaced");
    expect(otherStore.active(otherWorker.key(principal))).toBeUndefined();
    expect(otherStore.pendingRevocations()).toMatchObject([{ refreshToken: tokens.refreshToken }]);
    otherStore.close();
    test.store.close();
  });

  it("keeps the newer worker's connection when approvals complete out of order", async () => {
    let finishOlder!: (value: GrantTokens) => void;
    let finishNewer!: (value: GrantTokens) => void;
    const older = await fixture({
      startLogin: vi.fn(async () => ({
        poll: () => new Promise<GrantTokens>((resolve) => { finishOlder = resolve; }),
        userCode: "OLD1",
        verificationUrl: "https://omnigent.example/activate",
      })),
    });
    const newerStore = openStore(older.path);
    const newer = new GrantLifecycle(appId, omnigentOrigin, newerStore, {
      startLogin: vi.fn(async () => ({
        poll: () => new Promise<GrantTokens>((resolve) => { finishNewer = resolve; }),
        userCode: "NEW2",
        verificationUrl: "https://omnigent.example/activate",
      })),
    } as unknown as OmnigentDeviceClient);

    const olderPending = await older.lifecycle.connect(principal);
    const newerPending = await newer.connect(principal);
    const replacement = { ...tokens, grantId: "grant-2", refreshToken: "refresh-2" };
    finishNewer(replacement);
    await expect(newerPending.completion).resolves.toContain("connected");
    finishOlder(tokens);
    await expect(olderPending.completion).resolves.toContain("cancelled or replaced");

    expect(newerStore.active(newer.key(principal))).toMatchObject({ grantId: "grant-2" });
    expect(newerStore.pendingRevocations().map(({ refreshToken }) => refreshToken))
      .toContain(tokens.refreshToken);
    newerStore.close();
    older.store.close();
  });

  it("does not restore authority when another worker uninstalls before device approval", async () => {
    let finish!: (value: GrantTokens) => void;
    const test = await fixture({
      startLogin: vi.fn(async () => ({
        poll: () => new Promise<GrantTokens>((resolve) => { finish = resolve; }),
        userCode: "ABCD",
        verificationUrl: "https://omnigent.example/activate",
      })),
    });

    const pending = await test.lifecycle.connect(principal);
    const otherStore = openStore(test.path);
    const otherWorker = new GrantLifecycle(appId, omnigentOrigin, otherStore, {} as OmnigentDeviceClient);
    otherWorker.uninstall(principal);
    finish(tokens);
    await expect(pending.completion).resolves.toContain("cancelled or replaced");
    expect(otherStore.active(otherWorker.key(principal))).toBeUndefined();
    expect(otherStore.pendingRevocations()).toMatchObject([{ refreshToken: tokens.refreshToken }]);
    otherStore.close();
    test.store.close();
  });

  it("disables on logout immediately and reconciles remote revocation", async () => {
    const revoke = vi.fn(async () => true);
    const test = await fixture({ revoke });
    test.store.link(test.lifecycle.key(principal), tokens);

    expect(test.lifecycle.logout(principal)).toContain("disconnected locally");
    expect(test.store.active(test.lifecycle.key(principal))).toBeUndefined();
    expect(test.lifecycle.status(principal)).toContain("No Omnigent");
    await expect(test.lifecycle.reconcileRevocations()).resolves.toEqual({ completed: 1, deferred: 0 });
    expect(revoke).toHaveBeenCalledWith(tokens.refreshToken);
    expect(test.store.pendingRevocations()).toHaveLength(0);
    test.store.close();
  });

  it("keeps failed revocations durable for a later retry", async () => {
    const revoke = vi.fn(async () => false);
    const test = await fixture({ revoke });
    test.store.link(test.lifecycle.key(principal), tokens);
    test.lifecycle.logout(principal);

    await expect(test.lifecycle.reconcileRevocations()).resolves.toEqual({ completed: 0, deferred: 1 });
    expect(test.store.pendingRevocations(Date.now())).toHaveLength(0);
    test.store.close();
  });

  it("waits beyond six seconds so a second worker consumes the first worker's rotation", async () => {
    vi.useFakeTimers();
    let finish!: (value: GrantTokens) => void;
    const refresh = vi.fn(() => new Promise<GrantTokens>((resolve) => { finish = resolve; }));
    const test = await fixture({ refresh });
    test.store.link(test.lifecycle.key(principal), tokens);
    const otherStore = openStore(test.path);
    const otherWorker = new GrantLifecycle(appId, omnigentOrigin, otherStore, {
      refresh,
    } as unknown as OmnigentDeviceClient);

    const first = test.lifecycle.refreshAfterUnauthorized(principal, 1);
    const second = otherWorker.refreshAfterUnauthorized(principal, 1);
    let secondSettled = false;
    void second.then(
      () => { secondSettled = true; },
      () => { secondSettled = true; },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(secondSettled).toBe(false);
    finish({ ...tokens, accessToken: "access-2", grantId: "grant-2", refreshToken: "refresh-2" });
    await vi.advanceTimersByTimeAsync(100);
    const [left, right] = await Promise.all([first, second]);
    expect(left.generation).toBe(2);
    expect(right.generation).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    otherStore.close();
    test.store.close();
  });

  it("fails closed and retains cleanup evidence after an uncertain refresh response", async () => {
    const test = await fixture({
      refresh: vi.fn(async () => {
        throw new OmnigentOAuthError("malformed refresh response", true);
      }),
    });
    test.store.link(test.lifecycle.key(principal), tokens);

    await expect(test.lifecycle.refreshAfterUnauthorized(principal, 1)).rejects.toThrow("malformed");
    expect(test.store.active(test.lifecycle.key(principal))).toBeUndefined();
    expect(test.store.pendingRevocations()).toMatchObject([{ refreshToken: tokens.refreshToken }]);
    test.store.close();
  });

  it("uninstall disables the local grant and queues cleanup", async () => {
    const test = await fixture({});
    test.store.link(test.lifecycle.key(principal), tokens);
    test.lifecycle.uninstall(principal);
    expect(test.store.active(test.lifecycle.key(principal))).toBeUndefined();
    expect(test.lifecycle.status(principal)).toContain("No Omnigent");
    expect(test.store.pendingRevocations()).toHaveLength(1);
    test.store.close();
  });
});

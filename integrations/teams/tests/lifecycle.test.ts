import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GrantStore, type GrantTokens } from "../src/grants.js";
import type { EntraPrincipal } from "../src/identity.js";
import { GrantLifecycle } from "../src/lifecycle.js";
import type { OmnigentDeviceClient } from "../src/omnigent.js";

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

async function fixture(client: Partial<OmnigentDeviceClient>): Promise<{ lifecycle: GrantLifecycle; store: GrantStore }> {
  directory = await mkdtemp(join(tmpdir(), "omnigent-teams-lifecycle-"));
  const store = new GrantStore(join(directory, "grants.sqlite3"), Buffer.alloc(32, 4), {
    maximumLifetimeDays: 30,
  });
  return {
    lifecycle: new GrantLifecycle(appId, omnigentOrigin, store, client as OmnigentDeviceClient),
    store,
  };
}

afterEach(async () => {
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

  it("uses generation fencing so a second worker consumes the first worker's rotation", async () => {
    let finish!: (value: GrantTokens) => void;
    const refresh = vi.fn(() => new Promise<GrantTokens>((resolve) => { finish = resolve; }));
    const test = await fixture({ refresh });
    test.store.link(test.lifecycle.key(principal), tokens);

    const first = test.lifecycle.refreshAfterUnauthorized(principal, 1);
    const second = test.lifecycle.refreshAfterUnauthorized(principal, 1);
    finish({ ...tokens, accessToken: "access-2", grantId: "grant-2", refreshToken: "refresh-2" });
    const [left, right] = await Promise.all([first, second]);
    expect(left.generation).toBe(2);
    expect(right.generation).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
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

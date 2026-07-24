import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  ActivityDedupeCapacityError,
  ActivityDedupeStore,
} from "../src/dedupe.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "omnigent-teams-dedupe-"));
  temporaryDirectories.push(directory);
  return join(directory, "dedupe.sqlite3");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const key = {
  botAppId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  conversationId: "conversation-1",
  senderId: "sender-1",
  activityId: "activity-1",
};
const operation = { kind: "teams_reply", payload: "help" };

interface WorkerResult {
  status: "acquired" | "busy" | "delivered";
}

function openStore(path: string, maxRecords = 100): ActivityDedupeStore {
  return new ActivityDedupeStore(path, { leaseMilliseconds: 50, maxRecords, retentionDays: 7 });
}

function runWorker(
  databasePath: string,
  gatePath: string,
  readyPath: string,
  owner: string,
): Promise<WorkerResult> {
  const workerPath = fileURLToPath(new URL("./fixtures/dedupe-worker.ts", import.meta.url));

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, databasePath, gatePath, readyPath, owner],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`dedupe worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as WorkerResult);
    });
  });
}

async function waitUntilReady(paths: string[]): Promise<void> {
  for (let attempts = 0; attempts < 500; attempts += 1) {
    if (paths.every((path) => existsSync(path))) return;
    await delay(10);
  }
  throw new Error("dedupe workers did not reach the ready barrier");
}

describe("ActivityDedupeStore", () => {
  it("migrates ambiguous claim-only rows as pending so delivery is retried", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE activity_operations (
        bot_app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_app_id, tenant_id, conversation_id, sender_id, activity_id)
      );
    `);
    legacy.prepare(`
      INSERT INTO activity_operations (
        bot_app_id, tenant_id, conversation_id, sender_id, activity_id,
        kind, payload, created_at
      ) VALUES (
        @botAppId, @tenantId, @conversationId, @senderId, @activityId,
        @kind, @payload, 1000
      )
    `).run({ ...key, ...operation });
    legacy.close();

    const migrated = openStore(path);
    expect(migrated.claim(key, operation, "worker-1", 1_001)).toMatchObject({
      operation,
      status: "acquired",
    });
    expect(migrated.get(key)).toMatchObject({ attemptCount: 2, state: "pending" });
    migrated.close();
  });

  it("derives expiry from the last durable update when migrating existing rows", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE activity_operations (
        bot_app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        receipt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY (bot_app_id, tenant_id, conversation_id, sender_id, activity_id)
      );
    `);
    legacy.prepare(`
      INSERT INTO activity_operations (
        bot_app_id, tenant_id, conversation_id, sender_id, activity_id,
        kind, payload, state, lease_owner, lease_expires_at, attempt_count,
        receipt, created_at, updated_at, delivered_at
      ) VALUES (
        @botAppId, @tenantId, @conversationId, @senderId, @activityId,
        @kind, @payload, 'delivered', NULL, 0, 1,
        'reply-1', 1000, 2000, 2000
      )
    `).run({ ...key, ...operation });
    legacy.close();

    const migrated = openStore(path);
    expect(migrated.get(key)).toMatchObject({
      expiresAt: 2_000 + 7 * 24 * 60 * 60 * 1000,
      state: "delivered",
    });
    migrated.close();
  });

  it("persists a completed operation across connections and restart", () => {
    const path = databasePath();
    const first = openStore(path);
    const second = openStore(path);

    expect(first.claim(key, { kind: "teams_reply", payload: "help" }, "worker-1", 1_000)).toMatchObject({
      operation: { kind: "teams_reply", payload: "help" },
      status: "acquired",
    });
    first.complete(key, "worker-1", "reply-1", 1_001);
    expect(second.claim(key, { kind: "teams_reply", payload: "changed" }, "worker-2", 1_002)).toMatchObject({
      operation: { kind: "teams_reply", payload: "help" },
      receipt: "reply-1",
      status: "delivered",
    });
    expect(first.count()).toBe(1);
    first.close();
    second.close();

    const restarted = openStore(path);
    expect(restarted.get(key)).toMatchObject({ receipt: "reply-1", state: "delivered" });
    expect(restarted.count()).toBe(1);
    restarted.close();
  });

  it("isolates activity identities across every security-boundary key field", () => {
    const store = openStore(databasePath());
    const keys = [
      key,
      { ...key, botAppId: "33333333-3333-4333-8333-333333333333" },
      { ...key, tenantId: "44444444-4444-4444-8444-444444444444" },
      { ...key, conversationId: "conversation-2" },
      { ...key, senderId: "sender-2" },
      { ...key, activityId: "activity-2" },
    ];

    for (const [index, isolatedKey] of keys.entries()) {
      expect(store.claim(isolatedKey, operation, `worker-${index}`, 1_000).status)
        .toBe("acquired");
    }
    expect(store.count()).toBe(keys.length);
    store.close();
  });

  it("reclaims an abandoned lease after restart without adding a second operation", () => {
    const path = databasePath();
    const first = openStore(path);
    expect(first.claim(key, { kind: "teams_reply", payload: "help" }, "crashed", 1_000).status).toBe("acquired");
    first.close();

    const restarted = openStore(path);
    expect(restarted.claim(key, { kind: "teams_reply", payload: "help" }, "worker-2", 1_049).status).toBe("busy");
    expect(restarted.claim(key, { kind: "teams_reply", payload: "help" }, "worker-2", 1_050).status).toBe("acquired");
    restarted.complete(key, "worker-2", "reply-after-restart", 1_051);

    expect(restarted.get(key)).toMatchObject({
      attemptCount: 2,
      receipt: "reply-after-restart",
      state: "delivered",
    });
    expect(restarted.count()).toBe(1);
    restarted.close();
  });

  it("renews an owned lease and fences stale owners", () => {
    const store = openStore(databasePath());
    expect(store.claim(key, operation, "worker-1", 1_000).status).toBe("acquired");
    expect(store.renew(key, "worker-1", 1_040)).toBe(true);
    expect(store.claim(key, operation, "worker-2", 1_051).status).toBe("busy");
    expect(store.claim(key, operation, "worker-2", 1_091).status).toBe("acquired");
    expect(store.complete.bind(store, key, "worker-1", undefined, 1_092)).toThrow(/no longer owned/);
    store.complete(key, "worker-2", "reply-1", 1_093);
    store.close();
  });

  it("records expiry metadata and exposes bounded retention cleanup", () => {
    const store = new ActivityDedupeStore(databasePath(), {
      leaseMilliseconds: 50,
      maxRecords: 2,
      retentionDays: 1,
    });
    expect(store.claim(key, operation, "worker-1", 1_000).status).toBe("acquired");
    store.complete(key, "worker-1", "reply-1", 1_001);

    expect(store.get(key)).toMatchObject({ expiresAt: 1_001 + 24 * 60 * 60 * 1000 });
    expect(store.cleanupExpired(1_001 + 24 * 60 * 60 * 1000 - 1)).toBe(0);
    expect(store.cleanupExpired(1_001 + 24 * 60 * 60 * 1000)).toBe(1);
    expect(store.get(key)).toBeUndefined();
    store.close();
  });

  it("does not clean up a claim while its longer lease is still active", () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const store = new ActivityDedupeStore(databasePath(), {
      leaseMilliseconds: 2 * oneDay,
      maxRecords: 2,
      retentionDays: 1,
    });
    expect(store.claim(key, operation, "worker-1", 1_000).status).toBe("acquired");

    expect(store.cleanupExpired(1_000 + oneDay)).toBe(0);
    expect(store.claim(key, operation, "worker-2", 1_000 + oneDay).status).toBe("busy");
    expect(store.count()).toBe(1);
    store.close();
  });

  it("fails closed at capacity until retention expires", () => {
    const store = new ActivityDedupeStore(databasePath(), {
      leaseMilliseconds: 50,
      maxRecords: 1,
      retentionDays: 1,
    });
    expect(store.claim(key, operation, "worker-1", 1_000).status).toBe("acquired");
    store.complete(key, "worker-1", undefined, 1_001);
    expect(() => store.claim(
      { ...key, activityId: "activity-2" },
      operation,
      "worker-2",
      1_002,
    )).toThrow(ActivityDedupeCapacityError);
    expect(store.count()).toBe(1);

    expect(store.claim(
      { ...key, activityId: "activity-2" },
      operation,
      "worker-2",
      1_001 + 24 * 60 * 60 * 1000 + 1,
    ).status).toBe("acquired");
    expect(store.count()).toBe(1);
    store.close();
  });

  it("allows only one operating-system process to acquire the same activity", async () => {
    const path = databasePath();
    const directory = temporaryDirectories.at(-1)!;
    const gatePath = join(directory, "start");
    const readyPaths = Array.from({ length: 4 }, (_, index) => join(directory, `ready-${index}`));
    const workers = readyPaths.map((readyPath, index) => (
      runWorker(path, gatePath, readyPath, `worker-${index}`)
    ));

    await waitUntilReady(readyPaths);
    writeFileSync(gatePath, "go", { flag: "wx" });
    const results = await Promise.all(workers);

    expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "busy").length).toBeGreaterThanOrEqual(1);
    const restarted = openStore(path);
    expect(restarted.count()).toBe(1);
    expect(restarted.get({ ...key, activityId: "shared-activity" })).toMatchObject({ state: "delivered" });
    restarted.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeliveryInProgressError,
  handlePersonalMessage,
  validateActivity,
} from "../src/activity.js";
import { ActivityDedupeStore } from "../src/dedupe.js";

const appId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const temporaryDirectories: string[] = [];

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "activity-1",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    text: "help",
    from: { id: "sender-1", aadObjectId: objectId },
    recipient: { id: `28:${appId}` },
    conversation: { id: "conversation-1", conversationType: "personal", tenantId },
    channelData: { tenant: { id: tenantId } },
    ...overrides,
  };
}

function store(): ActivityDedupeStore {
  const directory = mkdtempSync(join(tmpdir(), "omnigent-teams-activity-"));
  temporaryDirectories.push(directory);
  return new ActivityDedupeStore(join(directory, "dedupe.sqlite3"), {
    leaseMilliseconds: 50,
    maxRecords: 100,
    retentionDays: 7,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("validateActivity", () => {
  const constraints = { botAppId: appId, allowedTenantIds: new Set([tenantId]) };

  it("binds a complete personal activity to its app, tenant, conversation, and sender", () => {
    expect(validateActivity(activity(), constraints)).toMatchObject({ ok: true, tenantId });
  });

  it.each([
    ["missing activity type", activity({ type: undefined })],
    ["missing service URL", activity({ serviceUrl: undefined })],
    ["missing tenant", activity({ conversation: { id: "conversation-1", conversationType: "personal" }, channelData: {} })],
    ["missing conversation tenant", activity({ conversation: { id: "conversation-1", conversationType: "personal" } })],
    ["missing channel tenant", activity({ channelData: {} })],
    ["missing sender object ID", activity({ from: { id: "sender-1" } })],
    ["malformed sender object ID", activity({ from: { id: "sender-1", aadObjectId: "not-a-guid" } })],
    ["disallowed tenant", activity({ conversation: { id: "conversation-1", conversationType: "personal", tenantId: "33333333-3333-4333-8333-333333333333" }, channelData: { tenant: { id: "33333333-3333-4333-8333-333333333333" } } })],
    ["mismatched tenant fields", activity({ channelData: { tenant: { id: "33333333-3333-4333-8333-333333333333" } } })],
    ["group chat", activity({ conversation: { id: "conversation-1", conversationType: "groupChat", tenantId } })],
    ["team channel", activity({ conversation: { id: "conversation-1", conversationType: "channel", tenantId } })],
    ["meeting scope", activity({ conversation: { id: "conversation-1", conversationType: "meeting", tenantId } })],
    ["unknown scope", activity({ conversation: { id: "conversation-1", conversationType: "livestream", tenantId } })],
    ["missing conversation scope", activity({ conversation: { id: "conversation-1", tenantId } })],
    ["empty conversation scope", activity({ conversation: { id: "conversation-1", conversationType: "", tenantId } })],
    ["wrong recipient app", activity({ recipient: { id: "28:44444444-4444-4444-8444-444444444444" } })],
    ["unprefixed recipient app", activity({ recipient: { id: appId } })],
    ["non-Teams channel", activity({ channelId: "slack" })],
    ["whitespace-padded activity ID", activity({ id: " activity-1" })],
  ])("rejects %s", (_name, candidate) => {
    expect(validateActivity(candidate, constraints)).toMatchObject({ ok: false });
  });

  it.each<[string, unknown]>([
    ["a string body", "not-an-activity"],
    ["a null body", null],
    ["a numeric body", 42],
    ["a boolean body", true],
    ["an array body", [activity()]],
  ])("rejects %s as malformed", (_name, candidate) => {
    expect(validateActivity(candidate, constraints)).toMatchObject({ ok: false, status: 400 });
  });

  it("classifies a scope violation as 403 and missing identity as 400", () => {
    expect(validateActivity(
      activity({ conversation: { id: "conversation-1", conversationType: "channel", tenantId } }),
      constraints,
    )).toMatchObject({ ok: false, status: 403 });
    expect(validateActivity(activity({ from: { id: "sender-1" } }), constraints))
      .toMatchObject({ ok: false, status: 400 });
  });
});

describe("handlePersonalMessage", () => {
  it("records and sends one static help response for a replayed activity ID", async () => {
    const dedupe = store();
    const send = vi.fn(async (_message: string) => ({ id: "reply-1" }));
    const constraints = { botAppId: appId, allowedTenantIds: new Set([tenantId]) };

    const results = [
      await handlePersonalMessage(activity(), constraints, dedupe, send),
      await handlePersonalMessage(activity(), constraints, dedupe, send),
    ];

    expect(results.filter((result) => result === "sent")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("help");
    expect(dedupe.count()).toBe(1);
    dedupe.close();
  });

  it("isolates replay records by the Entra sender object ID", async () => {
    const dedupe = store();
    const send = vi.fn(async (_message: string) => undefined);
    const constraints = { botAppId: appId, allowedTenantIds: new Set([tenantId]) };

    await handlePersonalMessage(activity(), constraints, dedupe, send);
    await handlePersonalMessage(
      activity({ from: { id: "sender-1", aadObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }),
      constraints,
      dedupe,
      send,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(dedupe.count()).toBe(2);
    dedupe.close();
  });

  it("does not replay an operation recorded under the legacy channel sender key", async () => {
    const dedupe = store();
    const legacyKey = {
      activityId: "activity-1",
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: "sender-1",
      tenantId,
    };
    const now = Date.now();
    dedupe.claim(legacyKey, { kind: "teams_reply", payload: "legacy help" }, "legacy-worker", now);
    dedupe.complete(legacyKey, "legacy-worker", "legacy-reply", now + 1);
    const send = vi.fn(async (_message: string) => undefined);

    await expect(handlePersonalMessage(
      activity(),
      { botAppId: appId, allowedTenantIds: new Set([tenantId]) },
      dedupe,
      send,
    )).resolves.toBe("duplicate");

    expect(send).not.toHaveBeenCalled();
    expect(dedupe.count()).toBe(1);
    dedupe.close();
  });

  it("releases a failed send for durable retry after process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnigent-teams-retry-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "dedupe.sqlite3");
    const constraints = { botAppId: appId, allowedTenantIds: new Set([tenantId]) };
    const first = new ActivityDedupeStore(path, {
      leaseMilliseconds: 50,
      maxRecords: 100,
      retentionDays: 7,
    });

    await expect(handlePersonalMessage(
      activity(),
      constraints,
      first,
      vi.fn().mockRejectedValue(new Error("send failed")),
    )).rejects.toThrow("send failed");
    expect(first.get({
      activityId: "activity-1",
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: objectId,
      tenantId,
    })).toMatchObject({ state: "pending" });
    first.close();

    const restarted = new ActivityDedupeStore(path, {
      leaseMilliseconds: 50,
      maxRecords: 100,
      retentionDays: 7,
    });
    const send = vi.fn(async (_message: string) => ({ id: "reply-after-restart" }));
    await expect(handlePersonalMessage(activity(), constraints, restarted, send)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(restarted.get({
      activityId: "activity-1",
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: objectId,
      tenantId,
    })).toMatchObject({
      attemptCount: 2,
      receipt: "reply-after-restart",
      state: "delivered",
    });
    restarted.close();
  });

  it("fences a simultaneous in-flight duplicate to one recorded operation", async () => {
    const dedupe = store();
    const constraints = { botAppId: appId, allowedTenantIds: new Set([tenantId]) };
    let releaseSend: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const send = vi.fn(async (_message: string) => {
      await gate;
      return { id: "reply-1" };
    });

    const first = handlePersonalMessage(activity(), constraints, dedupe, send);
    await expect(handlePersonalMessage(activity(), constraints, dedupe, send))
      .rejects.toBeInstanceOf(DeliveryInProgressError);

    releaseSend();
    await expect(first).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(dedupe.count()).toBe(1);
    expect(dedupe.get({
      activityId: "activity-1",
      botAppId: appId,
      conversationId: "conversation-1",
      senderId: objectId,
      tenantId,
    })).toMatchObject({ receipt: "reply-1", state: "delivered" });
    dedupe.close();
  });

  it("returns a bounded help-only response for unsupported commands without invoking Omnigent", async () => {
    const dedupe = store();
    const send = vi.fn(async (_message: string) => undefined);

    await handlePersonalMessage(
      activity({ id: "activity-unsupported", text: "new" }),
      { botAppId: appId, allowedTenantIds: new Set([tenantId]) },
      dedupe,
      send,
    );

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Unknown command"));
    dedupe.close();
  });
});

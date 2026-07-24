import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePersonalMessage, validateActivity } from "../src/activity.js";
import { ActivityDedupeStore } from "../src/dedupe.js";

const appId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "activity-1",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    text: "help",
    from: { id: "sender-1", aadObjectId: "object-1" },
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
    ["missing tenant", activity({ conversation: { id: "conversation-1", conversationType: "personal" }, channelData: {} })],
    ["missing sender object ID", activity({ from: { id: "sender-1" } })],
    ["disallowed tenant", activity({ conversation: { id: "conversation-1", conversationType: "personal", tenantId: "33333333-3333-4333-8333-333333333333" }, channelData: { tenant: { id: "33333333-3333-4333-8333-333333333333" } } })],
    ["mismatched tenant fields", activity({ channelData: { tenant: { id: "33333333-3333-4333-8333-333333333333" } } })],
    ["group chat", activity({ conversation: { id: "conversation-1", conversationType: "groupChat", tenantId } })],
    ["team channel", activity({ conversation: { id: "conversation-1", conversationType: "channel", tenantId } })],
    ["wrong recipient app", activity({ recipient: { id: "28:44444444-4444-4444-8444-444444444444" } })],
    ["non-Teams channel", activity({ channelId: "slack" })],
  ])("rejects %s", (_name, candidate) => {
    expect(validateActivity(candidate, constraints)).toMatchObject({ ok: false });
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
      senderId: "sender-1",
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
      senderId: "sender-1",
      tenantId,
    })).toMatchObject({
      attemptCount: 2,
      receipt: "reply-after-restart",
      state: "delivered",
    });
    restarted.close();
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

    expect(send).toHaveBeenCalledWith(expect.stringContaining("only `help`"));
    dedupe.close();
  });
});

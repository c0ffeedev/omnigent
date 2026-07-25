// Vitest cases for `parseEvent` — the raw-SSE-JSON → typed-event mapping.

import { describe, expect, it } from "vitest";
import { parseEvent } from "./sse";
import type { SessionStatusEvent, SessionSupersededEvent, TextDelta } from "./events";

describe("parseEvent — response.output_text.delta", () => {
  it("parses a plain delta with no streaming identifiers", () => {
    // Ordinary in-process task streaming: only `delta` is present, and
    // the native-scoping fields stay undefined so downstream treats it
    // as response-scoped (not message-scoped) text.
    const ev = parseEvent("response.output_text.delta", { delta: "Hi" });
    expect(ev).toEqual({
      type: "text_delta",
      delta: "Hi",
      messageId: undefined,
      index: undefined,
      final: undefined,
    } satisfies TextDelta);
  });

  it("threads message_id / index / final for claude-native streaming", () => {
    const ev = parseEvent("response.output_text.delta", {
      delta: "Hel",
      message_id: "m1",
      index: 0,
      final: false,
    });
    // All three native fields surface so the store can scope, order, and
    // finalize the in-flight buffer. index 0 and final false must NOT be
    // coerced to undefined (they're meaningful falsy values).
    expect(ev).toEqual({
      type: "text_delta",
      delta: "Hel",
      messageId: "m1",
      index: 0,
      final: false,
    } satisfies TextDelta);
  });

  it("ignores wrong-typed streaming identifiers rather than poisoning the buffer", () => {
    const ev = parseEvent("response.output_text.delta", {
      delta: "x",
      message_id: 7,
      index: "0",
      final: "yes",
    });
    // A malformed field is dropped (left undefined), so the delta still
    // renders as plain text instead of keying a buffer on garbage.
    expect(ev).toEqual({
      type: "text_delta",
      delta: "x",
      messageId: undefined,
      index: undefined,
      final: undefined,
    } satisfies TextDelta);
  });

  it("returns null when delta is not a string", () => {
    expect(parseEvent("response.output_text.delta", { delta: { text: "bad" } })).toBeNull();
  });
});

describe("parseEvent — session.superseded", () => {
  it("parses the carrier + redirect target", () => {
    const ev = parseEvent("session.superseded", {
      conversation_id: "conv_old",
      target_conversation_id: "conv_new",
      reason: "clear",
    });
    expect(ev).toEqual({
      type: "session_superseded",
      conversationId: "conv_old",
      targetConversationId: "conv_new",
      reason: "clear",
    } satisfies SessionSupersededEvent);
  });

  it("returns null when the target conversation id is missing", () => {
    expect(parseEvent("session.superseded", { conversation_id: "conv_old" })).toBeNull();
  });

  it("returns null when the carrier conversation id is missing", () => {
    expect(parseEvent("session.superseded", { target_conversation_id: "conv_new" })).toBeNull();
  });
});

describe("parseEvent — session.status (background_task_count)", () => {
  function bgCount(data: Record<string, unknown>): number | undefined {
    const ev = parseEvent("session.status", { conversation_id: "conv_a", status: "idle", ...data });
    return (ev as SessionStatusEvent | null)?.backgroundTaskCount;
  }

  it("threads a positive count so the indicator can show 'N background tasks still running'", () => {
    expect(bgCount({ background_task_count: 3 })).toBe(3);
  });

  it("keeps an explicit 0 (authoritative clear) rather than collapsing it to undefined", () => {
    // A Stop hook reporting zero remaining shells must reach the store as `0`
    // so the sticky tally clears; `undefined` would leave a finished shell's
    // indicator stuck on screen.
    expect(bgCount({ background_task_count: 0 })).toBe(0);
  });

  it("leaves the count undefined when the field is absent (no information)", () => {
    // The PTY-activity `idle` carries no count; absent must stay sticky-safe
    // (undefined), distinct from an authoritative 0.
    expect(bgCount({})).toBeUndefined();
  });

  it("ignores a non-numeric or negative count", () => {
    expect(bgCount({ background_task_count: "2" })).toBeUndefined();
    expect(bgCount({ background_task_count: -1 })).toBeUndefined();
  });
});

describe("parseEvent — session.mcp_startup", () => {
  it("parses a per-server startup map for the MCP startup band", () => {
    const ev = parseEvent("session.mcp_startup", {
      conversation_id: "conv_a",
      servers: {
        safe: { status: "failed", error: "handshake failed" },
        "storage-console": { status: "starting", error: null },
      },
    });
    expect(ev).toEqual({
      type: "session_mcp_startup",
      conversationId: "conv_a",
      servers: {
        safe: { status: "failed", error: "handshake failed" },
        "storage-console": { status: "starting", error: null },
      },
    });
  });

  it("skips entries with unknown statuses instead of dropping the frame", () => {
    // A partial map still updates the band; a bogus status must not reach
    // the store where it would render an unknown state.
    const ev = parseEvent("session.mcp_startup", {
      conversation_id: "conv_a",
      servers: {
        ok: { status: "ready" },
        bad: { status: "exploded" },
      },
    });
    expect(ev).toEqual({
      type: "session_mcp_startup",
      conversationId: "conv_a",
      servers: { ok: { status: "ready", error: null } },
    });
  });

  it("rejects frames without a conversation id or servers map", () => {
    expect(parseEvent("session.mcp_startup", { servers: {} })).toBeNull();
    expect(
      parseEvent("session.mcp_startup", { conversation_id: "conv_a", servers: "nope" }),
    ).toBeNull();
  });
});

describe("parseEvent — session.driver_lease", () => {
  it("parses the authoritative lease snapshot", () => {
    expect(
      parseEvent("session.driver_lease", {
        conversation_id: "sess-1",
        driver_lease: {
          session_id: "sess-1",
          holder_user_id: "alice@example.com",
          generation: 3,
          acquired_at: 10,
          renewed_at: 11,
          expires_at: 41,
          released_at: null,
          active: true,
        },
      }),
    ).toEqual({
      type: "session_driver_lease",
      conversationId: "sess-1",
      driverLease: {
        sessionId: "sess-1",
        holderUserId: "alice@example.com",
        generation: 3,
        acquiredAt: 10,
        renewedAt: 11,
        expiresAt: 41,
        releasedAt: null,
        active: true,
      },
    });
  });

  it("accepts the backend's nullable no-lease snapshot", () => {
    expect(
      parseEvent("session.driver_lease", {
        conversation_id: "sess-1",
        driver_lease: null,
      }),
    ).toEqual({
      type: "session_driver_lease",
      conversationId: "sess-1",
      driverLease: null,
    });
  });

  it("rejects a mismatched session", () => {
    expect(
      parseEvent("session.driver_lease", {
        conversation_id: "sess-1",
        driver_lease: {
          session_id: "sess-2",
          holder_user_id: null,
          generation: 1,
          acquired_at: null,
          renewed_at: null,
          expires_at: null,
          released_at: null,
          active: false,
        },
      }),
    ).toBeNull();
  });
});

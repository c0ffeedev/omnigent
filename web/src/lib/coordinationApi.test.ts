import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticatedFetchMock, fetchSessionItemsPageMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
  fetchSessionItemsPageMock: vi.fn(),
}));

vi.mock("./identity", () => ({
  authenticatedFetch: authenticatedFetchMock,
}));

vi.mock("./sessionsApi", () => ({
  fetchSessionItemsPage: fetchSessionItemsPageMock,
}));

import {
  acquireDriverLease,
  CoordinationApiError,
  DriverLeaseConflictError,
  fetchCoordinationAuditPage,
  getDriverLease,
  handoffDriverLease,
  heartbeatPresence,
  listCoordinationAudit,
  releaseDriverLease,
  renewDriverLease,
  type DriverLease,
} from "./coordinationApi";

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    json: async () => body,
  } as unknown as Response;
}

const currentLease: DriverLease = {
  sessionId: "sess-1",
  holderUserId: "alice@example.com",
  generation: 7,
  acquiredAt: 10,
  renewedAt: 11,
  expiresAt: 41,
  releasedAt: null,
  active: true,
};

beforeEach(() => {
  authenticatedFetchMock.mockReset();
  fetchSessionItemsPageMock.mockReset();
});

describe("coordination API", () => {
  it("maps lease and presence responses and sends generation-fenced mutations", async () => {
    const leaseWire = {
      session_id: currentLease.sessionId,
      holder_user_id: currentLease.holderUserId,
      generation: currentLease.generation,
      acquired_at: currentLease.acquiredAt,
      renewed_at: currentLease.renewedAt,
      expires_at: currentLease.expiresAt,
      released_at: currentLease.releasedAt,
      active: currentLease.active,
    };
    authenticatedFetchMock
      .mockResolvedValueOnce(mockJsonResponse(leaseWire))
      .mockResolvedValueOnce(mockJsonResponse(leaseWire))
      .mockResolvedValueOnce(mockJsonResponse(leaseWire))
      .mockResolvedValueOnce(mockJsonResponse(leaseWire))
      .mockResolvedValueOnce(mockJsonResponse(leaseWire))
      .mockResolvedValueOnce(
        mockJsonResponse({
          session_id: "sess-1",
          active_user_ids: ["alice@example.com"],
          entries: [{ user_id: "alice@example.com", last_seen: 10, expires_at: 70 }],
        }),
      );

    await expect(getDriverLease("sess/1")).resolves.toEqual(currentLease);
    await expect(acquireDriverLease("sess-1", { ttlSeconds: 45, force: true })).resolves.toEqual(
      currentLease,
    );
    await expect(renewDriverLease("sess-1", { generation: 7, ttlSeconds: 45 })).resolves.toEqual(
      currentLease,
    );
    await expect(releaseDriverLease("sess-1", { generation: 7 })).resolves.toEqual(currentLease);
    await expect(
      handoffDriverLease("sess-1", {
        generation: 7,
        holderUserId: "bob@example.com",
        ttlSeconds: 45,
      }),
    ).resolves.toEqual(currentLease);
    await expect(heartbeatPresence("sess-1", { ttlSeconds: 90 })).resolves.toEqual({
      sessionId: "sess-1",
      activeUserIds: ["alice@example.com"],
      entries: [{ userId: "alice@example.com", lastSeen: 10, expiresAt: 70 }],
    });

    expect(authenticatedFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions/sess%2F1/driver",
      "/v1/sessions/sess-1/driver/acquire",
      "/v1/sessions/sess-1/driver/renew",
      "/v1/sessions/sess-1/driver/release",
      "/v1/sessions/sess-1/driver/handoff",
      "/v1/sessions/sess-1/presence/heartbeat",
    ]);
    expect(JSON.parse(authenticatedFetchMock.mock.calls[2][1].body as string)).toEqual({
      generation: 7,
      ttl_seconds: 45,
    });
    expect(JSON.parse(authenticatedFetchMock.mock.calls[4][1].body as string)).toEqual({
      generation: 7,
      holder_user_id: "bob@example.com",
      ttl_seconds: 45,
    });
  });

  it("preserves authorization status, code, and message", async () => {
    authenticatedFetchMock.mockResolvedValueOnce(
      mockJsonResponse({ error: { code: "forbidden", message: "edit permission required" } }, 403),
    );

    const error = await renewDriverLease("sess-1", { generation: 7 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CoordinationApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "edit permission required",
    });
  });

  it("projects persisted driver resource events into audit records", async () => {
    fetchSessionItemsPageMock.mockResolvedValueOnce({
      hasMore: false,
      items: [
        {
          id: "item-1",
          type: "resource_event",
          response_id: "sess-1",
          status: "completed",
          event_type: "session.driver_lease.handed_off",
          resource_type: "driver_lease",
          resource: {
            session_id: "sess-1",
            actor_user_id: "alice@example.com",
            holder_user_id: "bob@example.com",
            generation: 8,
          },
          driver_generation: 8,
          created_at: 100,
        },
        { id: "item-2", type: "message", response_id: "sess-1", status: "completed" },
      ],
    });

    await expect(listCoordinationAudit("sess-1", { limit: 25 })).resolves.toEqual([
      {
        id: "item-1",
        eventType: "session.driver_lease.handed_off",
        sessionId: "sess-1",
        actorUserId: "alice@example.com",
        holderUserId: "bob@example.com",
        generation: 8,
        outcome: "completed",
        createdAt: 100,
      },
    ]);
    expect(fetchSessionItemsPageMock).toHaveBeenCalledWith("sess-1", {
      limit: 1_000,
      olderThan: undefined,
      signal: undefined,
    });
  });

  it("pages past unrelated items and forwards cancellation", async () => {
    const controller = new AbortController();
    fetchSessionItemsPageMock
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-1", type: "message", response_id: "sess-1", status: "completed" }],
      })
      .mockResolvedValueOnce({
        hasMore: false,
        items: [
          {
            id: "audit-1",
            type: "resource_event",
            response_id: "sess-1",
            status: "completed",
            event_type: "session.driver_lease.released",
            resource_type: "driver_lease",
            resource: { session_id: "sess-1", generation: 9 },
            driver_generation: 9,
          },
        ],
      });

    await expect(
      listCoordinationAudit("sess-1", { limit: 1, signal: controller.signal }),
    ).resolves.toEqual([expect.objectContaining({ id: "audit-1", generation: 9 })]);
    expect(fetchSessionItemsPageMock).toHaveBeenNthCalledWith(2, "sess-1", {
      limit: 1_000,
      olderThan: "cursor-1",
      signal: controller.signal,
    });
  });

  it("returns a newest-first bounded audit page with an older-history cursor", async () => {
    const controller = new AbortController();
    fetchSessionItemsPageMock.mockResolvedValueOnce({
      hasMore: true,
      items: [
        {
          id: "audit-old",
          type: "resource_event",
          response_id: "sess-1",
          status: "completed",
          event_type: "session.driver_lease.acquired",
          resource_type: "driver_lease",
          resource: { session_id: "sess-1", holder_user_id: "alice@example.com" },
          created_by: "alice@example.com",
          driver_generation: 1,
          created_at: 100,
        },
        { id: "message-1", type: "message", response_id: "sess-1", status: "completed" },
        {
          id: "audit-new",
          type: "resource_event",
          response_id: "sess-1",
          status: "completed",
          event_type: "session.driver_lease.handed_off",
          resource_type: "driver_lease",
          resource: {
            session_id: "sess-1",
            actor_user_id: "alice@example.com",
            holder_user_id: "bob@example.com",
            access_token: "must-not-escape",
          },
          driver_generation: 2,
          created_at: 200,
        },
      ],
    });

    const result = await fetchCoordinationAuditPage("sess-1", {
      cursor: "start-here",
      limit: 2,
      signal: controller.signal,
    });
    expect(result).toEqual({
      records: [
        expect.objectContaining({
          id: "audit-new",
          actorUserId: "alice@example.com",
          holderUserId: "bob@example.com",
          outcome: "completed",
          createdAt: 200,
        }),
        expect.objectContaining({
          id: "audit-old",
          // Falls back to the server-attributed common field when the
          // resource payload predates actor_user_id.
          actorUserId: "alice@example.com",
          createdAt: 100,
        }),
      ],
      nextCursor: "audit-old",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(fetchSessionItemsPageMock).toHaveBeenCalledWith("sess-1", {
      limit: 100,
      olderThan: "start-here",
      signal: controller.signal,
    });
  });

  it("caps sparse-history scans and leaves a cursor so older records remain reachable", async () => {
    fetchSessionItemsPageMock
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-1", type: "message", response_id: "sess-1", status: "completed" }],
      })
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-2", type: "message", response_id: "sess-1", status: "completed" }],
      })
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-3", type: "message", response_id: "sess-1", status: "completed" }],
      })
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-4", type: "message", response_id: "sess-1", status: "completed" }],
      });

    await expect(fetchCoordinationAuditPage("sess-1")).resolves.toEqual({
      records: [],
      nextCursor: "cursor-4",
    });
    expect(fetchSessionItemsPageMock).toHaveBeenCalledTimes(4);
    expect(fetchSessionItemsPageMock).toHaveBeenNthCalledWith(4, "sess-1", {
      limit: 100,
      olderThan: "cursor-3",
      signal: undefined,
    });
  });

  it("bounds compatibility-list scans when no coordination records are present", async () => {
    fetchSessionItemsPageMock
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-1", type: "message", response_id: "sess-1", status: "completed" }],
      })
      .mockResolvedValueOnce({
        hasMore: true,
        items: [{ id: "cursor-2", type: "message", response_id: "sess-1", status: "completed" }],
      });

    await expect(listCoordinationAudit("sess-1", { maxPages: 2 })).resolves.toEqual([]);
    expect(fetchSessionItemsPageMock).toHaveBeenCalledTimes(2);
  });
});

describe("driver lease conflicts", () => {
  it("surfaces the authoritative current lease for immediate reconciliation", async () => {
    authenticatedFetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        {
          error: {
            code: "conflict",
            message: "Driver generation mismatch",
            details: {
              driver_lease: {
                session_id: currentLease.sessionId,
                holder_user_id: currentLease.holderUserId,
                generation: currentLease.generation,
                acquired_at: currentLease.acquiredAt,
                renewed_at: currentLease.renewedAt,
                expires_at: currentLease.expiresAt,
                released_at: currentLease.releasedAt,
                active: currentLease.active,
              },
            },
          },
        },
        409,
      ),
    );

    let caught: unknown;
    try {
      await acquireDriverLease("sess-1");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DriverLeaseConflictError);
    expect((caught as DriverLeaseConflictError).currentLease).toEqual(currentLease);
    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      "/v1/sessions/sess-1/driver/acquire",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ttl_seconds: 30, force: false }),
      }),
    );
  });
});

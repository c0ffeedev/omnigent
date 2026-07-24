import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticatedFetchMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
}));

vi.mock("./identity", () => ({
  authenticatedFetch: authenticatedFetchMock,
}));

import { acquireDriverLease, DriverLeaseConflictError, type DriverLease } from "./coordinationApi";

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

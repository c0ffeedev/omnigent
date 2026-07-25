import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { DriverLease } from "./coordinationApi";
import {
  applyDriverLeaseToCoordinationCache,
  coordinationQueryKey,
  mergeCoordinationSnapshot,
  mergeDriverLease,
} from "./coordinationState";

const lease: DriverLease = {
  sessionId: "sess-1",
  holderUserId: "alice@example.com",
  generation: 3,
  acquiredAt: 10,
  renewedAt: 11,
  expiresAt: 41,
  releasedAt: null,
  active: true,
};

const presence = {
  sessionId: "sess-1",
  activeUserIds: ["alice@example.com"],
  entries: [{ userId: "alice@example.com", lastSeen: 10, expiresAt: 70 }],
};

describe("mergeDriverLease", () => {
  it("rejects an older generation that completes after a newer mutation", () => {
    const current = { ...lease, generation: 4, holderUserId: "bob@example.com" };
    expect(mergeDriverLease(current, lease)).toBe(current);
  });

  it("keeps a same-generation release over an older active snapshot", () => {
    const released = { ...lease, active: false, releasedAt: 20 };
    expect(mergeDriverLease(released, lease)).toBe(released);
  });

  it("accepts a later same-generation renewal", () => {
    const renewed = { ...lease, renewedAt: 20, expiresAt: 50 };
    expect(mergeDriverLease(lease, renewed)).toBe(renewed);
  });
});

describe("mergeCoordinationSnapshot", () => {
  it("updates presence without letting a stale poll roll back the lease", () => {
    const currentLease = { ...lease, generation: 4, holderUserId: "bob@example.com" };
    const nextPresence = {
      ...presence,
      activeUserIds: ["alice@example.com", "bob@example.com"],
    };

    expect(
      mergeCoordinationSnapshot(
        { driverLease: currentLease, presence },
        { driverLease: lease, presence: nextPresence },
      ),
    ).toEqual({ driverLease: currentLease, presence: nextPresence });
  });

  it("keeps an existing lease when a delayed poll returns a nullable empty snapshot", () => {
    expect(
      mergeCoordinationSnapshot({ driverLease: lease, presence }, { driverLease: null, presence }),
    ).toEqual({ driverLease: lease, presence });
  });
});

describe("applyDriverLeaseToCoordinationCache", () => {
  it("treats a nullable SSE snapshot as an authoritative clear", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(coordinationQueryKey("sess-1"), { driverLease: lease, presence });

    applyDriverLeaseToCoordinationCache(queryClient, "sess-1", null);

    expect(queryClient.getQueryData(coordinationQueryKey("sess-1"))).toEqual({
      driverLease: null,
      presence,
    });
  });
});

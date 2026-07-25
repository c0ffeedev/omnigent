import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  acquireDriverLeaseMock,
  getDriverLeaseMock,
  heartbeatPresenceMock,
  handoffDriverLeaseMock,
  releaseDriverLeaseMock,
  renewDriverLeaseMock,
} = vi.hoisted(() => ({
  acquireDriverLeaseMock: vi.fn(),
  getDriverLeaseMock: vi.fn(),
  heartbeatPresenceMock: vi.fn(),
  handoffDriverLeaseMock: vi.fn(),
  releaseDriverLeaseMock: vi.fn(),
  renewDriverLeaseMock: vi.fn(),
}));

vi.mock("@/lib/coordinationApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coordinationApi")>();
  return {
    ...actual,
    acquireDriverLease: acquireDriverLeaseMock,
    getDriverLease: getDriverLeaseMock,
    heartbeatPresence: heartbeatPresenceMock,
    handoffDriverLease: handoffDriverLeaseMock,
    releaseDriverLease: releaseDriverLeaseMock,
    renewDriverLease: renewDriverLeaseMock,
  };
});

vi.mock("@/lib/identity", () => ({
  getCurrentUserId: () => "alice@example.com",
  resolveIdentity: () => Promise.resolve("alice@example.com"),
}));

import { DriverLeaseConflictError, type DriverLease } from "@/lib/coordinationApi";
import { useCoordination } from "./useCoordination";

const currentLease: DriverLease = {
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
  activeUserIds: ["alice@example.com", "bob@example.com"],
  entries: [
    { userId: "alice@example.com", lastSeen: 10, expiresAt: 70 },
    { userId: "bob@example.com", lastSeen: 11, expiresAt: 71 },
  ],
};

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  acquireDriverLeaseMock.mockReset();
  getDriverLeaseMock.mockReset().mockResolvedValue(currentLease);
  heartbeatPresenceMock.mockReset().mockResolvedValue(presence);
  handoffDriverLeaseMock.mockReset();
  releaseDriverLeaseMock.mockReset();
  renewDriverLeaseMock.mockReset();
});

describe("useCoordination", () => {
  it("hydrates the authoritative lease and family presence on mount", async () => {
    const { result, unmount } = renderHook(() => useCoordination("sess-1"), {
      wrapper: makeWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.connectionState).toBe("connected"));
    expect(result.current.driverLease).toEqual(currentLease);
    expect(result.current.presence).toEqual(presence);
    expect(result.current.currentDriverUserId).toBe("alice@example.com");
    expect(result.current.isCurrentUserDriver).toBe(true);
    expect(result.current.activeParticipantIds).toEqual(["alice@example.com", "bob@example.com"]);
    expect(result.current.participants).toEqual(presence.entries);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isStale).toBe(false);
    expect(result.current.updatedAt).not.toBeNull();
    expect(getDriverLeaseMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(heartbeatPresenceMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    unmount();
  });

  it("deduplicates the shared snapshot request across hook consumers", async () => {
    const { result, unmount } = renderHook(
      () => [useCoordination("sess-1"), useCoordination("sess-1")] as const,
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current[0].connectionState).toBe("connected"));
    expect(result.current[1].connectionState).toBe("connected");
    expect(getDriverLeaseMock).toHaveBeenCalledTimes(1);
    expect(heartbeatPresenceMock).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("keeps routine refreshes connected while the safety snapshot is in flight", async () => {
    let resolveLease!: (lease: DriverLease) => void;
    let resolvePresence!: (value: typeof presence) => void;
    const { result, unmount } = renderHook(() => useCoordination("sess-1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.connectionState).toBe("connected"));
    getDriverLeaseMock.mockImplementationOnce(
      () => new Promise<DriverLease>((resolve) => (resolveLease = resolve)),
    );
    heartbeatPresenceMock.mockImplementationOnce(
      () => new Promise<typeof presence>((resolve) => (resolvePresence = resolve)),
    );

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.isStale).toBe(false);

    await act(async () => {
      resolveLease(currentLease);
      resolvePresence(presence);
      await refreshPromise;
    });
    expect(result.current.connectionState).toBe("connected");

    unmount();
  });

  it("reconciles a stale mutation from the lease returned with a conflict", async () => {
    const authoritativeLease = { ...currentLease, holderUserId: "bob@example.com", generation: 4 };
    const conflict = new DriverLeaseConflictError("Driver generation mismatch", authoritativeLease);
    acquireDriverLeaseMock.mockRejectedValueOnce(conflict);
    const { result, unmount } = renderHook(() => useCoordination("sess-1"), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.connectionState).toBe("connected"));
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.acquire();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(conflict);
    await waitFor(() => expect(result.current.driverLease).toEqual(authoritativeLease));
    expect(result.current.isCurrentUserDriver).toBe(false);
    expect(result.current.actionError).toBe(conflict);

    const renewedLease = { ...authoritativeLease, renewedAt: 20, expiresAt: 50 };
    renewDriverLeaseMock.mockResolvedValueOnce(renewedLease);
    await act(async () => {
      await result.current.renew({ generation: authoritativeLease.generation });
    });
    expect(result.current.driverLease).toEqual(renewedLease);
    expect(result.current.actionError).toBeNull();

    unmount();
  });

  it("reconciles an older conflict without overwriting the latest action state", async () => {
    let rejectAcquire!: (error: Error) => void;
    acquireDriverLeaseMock.mockImplementationOnce(
      () => new Promise<DriverLease>((_resolve, reject) => (rejectAcquire = reject)),
    );
    const renewedLease = { ...currentLease, generation: 4, renewedAt: 20, expiresAt: 50 };
    const authoritativeLease = {
      ...renewedLease,
      holderUserId: "bob@example.com",
      generation: 5,
    };
    renewDriverLeaseMock.mockResolvedValueOnce(renewedLease);
    const { result, unmount } = renderHook(() => useCoordination("sess-1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.connectionState).toBe("connected"));

    let acquireResult!: Promise<unknown>;
    act(() => {
      acquireResult = result.current.acquire().catch((error: unknown) => error);
    });
    await act(async () => {
      await result.current.renew({ generation: currentLease.generation });
    });
    await act(async () => {
      rejectAcquire(new DriverLeaseConflictError("stale acquire", authoritativeLease));
      await acquireResult;
    });

    await waitFor(() => expect(result.current.driverLease).toEqual(authoritativeLease));
    expect(result.current.actionError).toBeNull();

    unmount();
  });

  it("keeps stale data visible and exposes refresh errors", async () => {
    const refreshError = new Error("coordination unavailable");
    const { result, unmount } = renderHook(() => useCoordination("sess-1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.connectionState).toBe("connected"));
    getDriverLeaseMock.mockRejectedValueOnce(refreshError);

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.refresh();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(refreshError);
    expect(result.current.connectionState).toBe("error");
    expect(result.current.error).toBe(refreshError);
    expect(result.current.isStale).toBe(true);
    expect(result.current.driverLease).toEqual(currentLease);
    expect(result.current.activeParticipantIds).toEqual(presence.activeUserIds);

    unmount();
  });
});

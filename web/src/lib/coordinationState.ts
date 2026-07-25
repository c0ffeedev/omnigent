import type { QueryClient } from "@tanstack/react-query";

import type { CoordinationPresence, DriverLease } from "./coordinationApi";

export interface LiveCoordinationPresence extends CoordinationPresence {
  idleUserIds?: string[];
  source?: "session-stream";
}

export interface CoordinationSnapshot {
  driverLease: DriverLease | null;
  presence: LiveCoordinationPresence | null;
}

export function coordinationQueryKey(sessionId: string): readonly unknown[] {
  return ["session", sessionId, "coordination"];
}

export function coordinationAuditQueryKey(sessionId: string): readonly unknown[] {
  return ["session", sessionId, "coordination-audit"];
}

function leaseVersion(lease: DriverLease): number {
  return Math.max(lease.releasedAt ?? -1, lease.renewedAt ?? -1, lease.acquiredAt ?? -1);
}

/** Preserve the newest fenced lease when polls, mutations, and SSE frames race. */
export function mergeDriverLease(
  current: DriverLease | null | undefined,
  incoming: DriverLease | null,
): DriverLease | null {
  if (current == null) return incoming;
  if (incoming == null) return current;
  if (incoming.generation !== current.generation) {
    return incoming.generation > current.generation ? incoming : current;
  }
  if (incoming.releasedAt !== null || current.releasedAt !== null) {
    if (incoming.releasedAt === null) return current;
    if (current.releasedAt === null) return incoming;
  }
  return leaseVersion(incoming) >= leaseVersion(current) ? incoming : current;
}

export function mergeCoordinationSnapshot(
  current: CoordinationSnapshot | undefined,
  incoming: CoordinationSnapshot,
): CoordinationSnapshot {
  if (
    current?.presence?.source === "session-stream" &&
    incoming.presence?.source !== "session-stream"
  ) {
    return {
      driverLease: mergeDriverLease(current.driverLease, incoming.driverLease),
      presence: current.presence,
    };
  }
  const idleUserIds =
    incoming.presence?.idleUserIds ??
    current?.presence?.idleUserIds?.filter((userId) =>
      incoming.presence?.activeUserIds.includes(userId),
    );
  const presence =
    incoming.presence === null
      ? null
      : idleUserIds === undefined
        ? incoming.presence
        : { ...incoming.presence, idleUserIds };

  return {
    driverLease: mergeDriverLease(current?.driverLease, incoming.driverLease),
    presence,
  };
}

/** Apply a live `session.driver_lease` frame without waiting for the safety poll. */
export function applyDriverLeaseToCoordinationCache(
  queryClient: QueryClient,
  sessionId: string,
  driverLease: DriverLease | null,
): void {
  queryClient.setQueryData<CoordinationSnapshot>(
    coordinationQueryKey(sessionId),
    (previous: CoordinationSnapshot | undefined) => ({
      driverLease:
        driverLease === null ? null : mergeDriverLease(previous?.driverLease, driverLease),
      presence: previous?.presence ?? null,
    }),
  );
  void queryClient.invalidateQueries({ queryKey: coordinationAuditQueryKey(sessionId) });
}

export function applyPresenceToCoordinationCache(
  queryClient: QueryClient,
  sessionId: string,
  viewers: Array<{ userId: string; idle: boolean }>,
): void {
  queryClient.setQueryData<CoordinationSnapshot>(coordinationQueryKey(sessionId), (current) => {
    const activeUserIds = viewers.map((viewer) => viewer.userId);
    const activeUsers = new Set(activeUserIds);
    return {
      driverLease: current?.driverLease ?? null,
      presence: {
        sessionId,
        activeUserIds,
        entries: current?.presence?.entries.filter((entry) => activeUsers.has(entry.userId)) ?? [],
        idleUserIds: viewers.filter((viewer) => viewer.idle).map((viewer) => viewer.userId),
        source: "session-stream",
      },
    };
  });
}

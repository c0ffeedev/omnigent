import type { QueryClient } from "@tanstack/react-query";

import type { CoordinationPresence, DriverLease } from "./coordinationApi";

export interface CoordinationSnapshot {
  driverLease: DriverLease | null;
  presence: CoordinationPresence | null;
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
  return {
    driverLease: mergeDriverLease(current?.driverLease, incoming.driverLease),
    presence: incoming.presence,
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

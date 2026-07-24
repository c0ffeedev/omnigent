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

/** Apply a live `session.driver_lease` frame without waiting for the safety poll. */
export function applyDriverLeaseToCoordinationCache(
  queryClient: QueryClient,
  sessionId: string,
  driverLease: DriverLease | null,
): void {
  queryClient.setQueryData<CoordinationSnapshot>(
    coordinationQueryKey(sessionId),
    (previous: CoordinationSnapshot | undefined) => ({
      driverLease,
      presence: previous?.presence ?? null,
    }),
  );
  void queryClient.invalidateQueries({ queryKey: coordinationAuditQueryKey(sessionId) });
}

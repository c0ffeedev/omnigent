import type { QueryClient } from "@tanstack/react-query";

import { getDriverLease, type DriverLease } from "@/lib/coordinationApi";
import { coordinationQueryKey, type CoordinationSnapshot } from "@/lib/coordinationState";
import { postEvent } from "@/lib/sessionsApi";
import type { SessionEventInput } from "@/lib/types";

const driverSourceClientId =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let driverSourceSequence = 0;

/** Return a stable identity for one browser-authored event attempt. */
export function nextDriverSourceId(kind: string, attemptId?: string): string {
  if (attemptId !== undefined) {
    return `web:${driverSourceClientId}:${kind}:${attemptId}`;
  }
  driverSourceSequence += 1;
  return `web:${driverSourceClientId}:${kind}:${driverSourceSequence}`;
}

async function currentDriverLease(
  queryClient: QueryClient,
  sessionId: string,
  requireAuthoritative: boolean,
): Promise<DriverLease | null> {
  if (!requireAuthoritative) {
    const cached = queryClient.getQueryData<CoordinationSnapshot>(coordinationQueryKey(sessionId));
    return cached?.driverLease ?? null;
  }

  // Approval and stop actions may target off-screen sessions or outlive a
  // composite cache snapshot. Always fetch their fence before posting.
  // The separate key avoids corrupting the composite coordination cache shape.
  return queryClient.fetchQuery({
    queryKey: ["session", sessionId, "coordination", "action-driver-lease"],
    queryFn: ({ signal }) => getDriverLease(sessionId, { signal }),
    staleTime: 0,
    retry: false,
  });
}

/** Attach the current authoritative lease token to a turn-controlling event. */
export async function postCoordinatedEvent(
  queryClient: QueryClient | null,
  sessionId: string,
  event: SessionEventInput,
  sourceId: string,
): ReturnType<typeof postEvent> {
  const requireAuthoritative = event.type === "approval" || event.type === "stop_session";
  if (requireAuthoritative && queryClient === null) {
    throw new Error(`Cannot post ${event.type} without coordination state`);
  }
  const lease =
    queryClient === null
      ? null
      : await currentDriverLease(queryClient, sessionId, requireAuthoritative);
  return postEvent(
    sessionId,
    lease?.active === true
      ? { ...event, source_id: sourceId, driver_generation: lease.generation }
      : event,
  );
}

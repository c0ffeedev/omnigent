import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  acquireDriverLease,
  DriverLeaseConflictError,
  getDriverLease,
  handoffDriverLease,
  heartbeatPresence,
  listCoordinationAudit,
  releaseDriverLease,
  renewDriverLease,
  type AcquireDriverLeaseOptions,
  type CoordinationAuditRecord,
  type DriverLease,
  type GenerationLeaseOptions,
  type HandoffDriverLeaseOptions,
} from "@/lib/coordinationApi";
import {
  applyDriverLeaseToCoordinationCache,
  coordinationAuditQueryKey,
  coordinationQueryKey,
  type CoordinationSnapshot,
} from "@/lib/coordinationState";
import { getCurrentUserId } from "@/lib/identity";

export type { CoordinationSnapshot } from "@/lib/coordinationState";

export const COORDINATION_REFRESH_INTERVAL_MS = 20_000;

export type CoordinationConnectionState =
  "offline" | "connecting" | "connected" | "reconnecting" | "error";

interface OnlineEventTarget {
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface CoordinationSyncOptions {
  refresh(signal: AbortSignal): Promise<CoordinationSnapshot>;
  onSnapshot(snapshot: CoordinationSnapshot): void;
  onConnectionState(state: CoordinationConnectionState, error: Error | null): void;
  intervalMs?: number;
  eventTarget?: OnlineEventTarget;
  isOnline?: () => boolean;
}

/**
 * Keep one session's coordination snapshot fresh and release every owned
 * browser resource when the last consumer unmounts or switches sessions.
 */
export function startCoordinationSync(options: CoordinationSyncOptions): () => void {
  const intervalMs = options.intervalMs ?? COORDINATION_REFRESH_INTERVAL_MS;
  const eventTarget = options.eventTarget ?? (typeof window === "undefined" ? undefined : window);
  const isOnline =
    options.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
  let stopped = false;
  let connectedOnce = false;
  let connectionState: CoordinationConnectionState = "connecting";
  let request: AbortController | null = null;

  const setConnectionState = (state: CoordinationConnectionState, error: Error | null) => {
    connectionState = state;
    options.onConnectionState(state, error);
  };

  const refresh = async (force = false): Promise<void> => {
    if (stopped) return;
    if (!isOnline()) {
      request?.abort();
      request = null;
      setConnectionState("offline", null);
      return;
    }
    if (request !== null) {
      if (!force) return;
      request.abort();
    }
    const controller = new AbortController();
    request = controller;
    if (!connectedOnce) {
      setConnectionState("connecting", null);
    } else if (force || connectionState !== "connected") {
      setConnectionState("reconnecting", null);
    }
    try {
      const snapshot = await options.refresh(controller.signal);
      if (stopped || controller.signal.aborted || request !== controller) return;
      connectedOnce = true;
      options.onSnapshot(snapshot);
      setConnectionState("connected", null);
    } catch (error) {
      if (stopped || controller.signal.aborted || request !== controller) return;
      setConnectionState("error", error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (request === controller) request = null;
    }
  };

  const handleOnline = () => void refresh(true);
  const handleOffline = () => {
    request?.abort();
    request = null;
    setConnectionState("offline", null);
  };
  eventTarget?.addEventListener("online", handleOnline);
  eventTarget?.addEventListener("offline", handleOffline);
  const timer = setInterval(() => void refresh(), intervalMs);
  void refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    eventTarget?.removeEventListener("online", handleOnline);
    eventTarget?.removeEventListener("offline", handleOffline);
    request?.abort();
    request = null;
  };
}

export interface UseCoordinationResult extends CoordinationSnapshot {
  connectionState: CoordinationConnectionState;
  error: Error | null;
  isCurrentUserDriver: boolean;
  refresh(): Promise<void>;
  acquire(options?: AcquireDriverLeaseOptions): Promise<DriverLease>;
  renew(options: GenerationLeaseOptions): Promise<DriverLease>;
  release(options: GenerationLeaseOptions): Promise<DriverLease>;
  handoff(options: HandoffDriverLeaseOptions): Promise<DriverLease>;
}

export function useCoordination(sessionId: string): UseCoordinationResult {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<CoordinationConnectionState>("connecting");
  const [error, setError] = useState<Error | null>(null);
  const query = useQuery<CoordinationSnapshot>({
    queryKey: coordinationQueryKey(sessionId),
    queryFn: async ({ signal }: { signal: AbortSignal }) => ({
      driverLease: await getDriverLease(sessionId, { signal }),
      presence: await heartbeatPresence(sessionId, { signal }),
    }),
    enabled: false,
  });

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const snapshot = await Promise.all([
      getDriverLease(sessionId, { signal: controller.signal }),
      heartbeatPresence(sessionId, { signal: controller.signal }),
    ]).then(([driverLease, presence]) => ({ driverLease, presence }));
    queryClient.setQueryData(coordinationQueryKey(sessionId), snapshot);
  }, [queryClient, sessionId]);

  useEffect(() => {
    setConnectionState("connecting");
    setError(null);
    return startCoordinationSync({
      refresh: async (signal) => {
        const [driverLease, presence] = await Promise.all([
          getDriverLease(sessionId, { signal }),
          heartbeatPresence(sessionId, { signal }),
        ]);
        return { driverLease, presence };
      },
      onSnapshot: (snapshot) => {
        queryClient.setQueryData(coordinationQueryKey(sessionId), snapshot);
      },
      onConnectionState: (nextState, nextError) => {
        setConnectionState(nextState);
        setError(nextError);
      },
    });
  }, [queryClient, sessionId]);

  const settleLease = useCallback(
    (lease: DriverLease) => {
      applyDriverLeaseToCoordinationCache(queryClient, sessionId, lease);
      return lease;
    },
    [queryClient, sessionId],
  );
  const reconcileConflict = useCallback(
    (mutationError: Error) => {
      if (mutationError instanceof DriverLeaseConflictError) {
        applyDriverLeaseToCoordinationCache(queryClient, sessionId, mutationError.currentLease);
      }
    },
    [queryClient, sessionId],
  );

  const acquireMutation = useMutation({
    mutationFn: (options: AcquireDriverLeaseOptions = {}) => acquireDriverLease(sessionId, options),
    onSuccess: settleLease,
    onError: reconcileConflict,
  });
  const renewMutation = useMutation({
    mutationFn: (options: GenerationLeaseOptions) => renewDriverLease(sessionId, options),
    onSuccess: settleLease,
    onError: reconcileConflict,
  });
  const releaseMutation = useMutation({
    mutationFn: (options: GenerationLeaseOptions) => releaseDriverLease(sessionId, options),
    onSuccess: settleLease,
    onError: reconcileConflict,
  });
  const handoffMutation = useMutation({
    mutationFn: (options: HandoffDriverLeaseOptions) => handoffDriverLease(sessionId, options),
    onSuccess: settleLease,
    onError: reconcileConflict,
  });

  const driverLease = query.data?.driverLease ?? null;
  const currentUserId = getCurrentUserId();
  return {
    driverLease,
    presence: query.data?.presence ?? null,
    connectionState,
    error,
    isCurrentUserDriver:
      driverLease?.active === true && driverLease.holderUserId === (currentUserId ?? "local"),
    refresh,
    acquire: acquireMutation.mutateAsync,
    renew: renewMutation.mutateAsync,
    release: releaseMutation.mutateAsync,
    handoff: handoffMutation.mutateAsync,
  };
}

export interface UseCoordinationAuditResult {
  records: CoordinationAuditRecord[];
  isLoading: boolean;
  error: Error | null;
}

export function useCoordinationAudit(sessionId: string): UseCoordinationAuditResult {
  const query = useQuery({
    queryKey: coordinationAuditQueryKey(sessionId),
    queryFn: () => listCoordinationAudit(sessionId),
  });
  return {
    records: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

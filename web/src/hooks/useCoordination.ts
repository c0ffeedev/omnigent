import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  type PresenceEntry,
} from "@/lib/coordinationApi";
import {
  applyDriverLeaseToCoordinationCache,
  coordinationAuditQueryKey,
  coordinationQueryKey,
  mergeCoordinationSnapshot,
  type CoordinationSnapshot,
} from "@/lib/coordinationState";
import { getCurrentUserId, resolveIdentity } from "@/lib/identity";

export type { CoordinationSnapshot } from "@/lib/coordinationState";

export const COORDINATION_REFRESH_INTERVAL_MS = 20_000;
const PUBLIC_DRIVER_USER_ID = "__public__";

export type CoordinationConnectionState =
  | "offline"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

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
  isLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
  updatedAt: number | null;
  activeParticipantIds: string[];
  participants: PresenceEntry[];
  currentDriverUserId: string | null;
  isCurrentUserDriver: boolean;
  isActionPending: boolean;
  actionError: Error | null;
  refresh(): Promise<void>;
  acquire(options?: AcquireDriverLeaseOptions): Promise<DriverLease>;
  renew(options: GenerationLeaseOptions): Promise<DriverLease>;
  release(options: GenerationLeaseOptions): Promise<DriverLease>;
  handoff(options: HandoffDriverLeaseOptions): Promise<DriverLease>;
}

export function useCoordination(sessionId: string): UseCoordinationResult {
  const queryClient = useQueryClient();
  const actionSequence = useRef(0);
  const isOnline = useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
  const [viewer, setViewer] = useState<{ loaded: boolean; userId: string | null }>(() => {
    const userId = getCurrentUserId();
    return { loaded: userId !== null, userId };
  });
  const [actionError, setActionError] = useState<Error | null>(null);
  const [offlineRecoveryTimestamp, setOfflineRecoveryTimestamp] = useState<number | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<{
    error: Error;
    dataUpdatedAt: number;
  } | null>(null);
  const query = useQuery<CoordinationSnapshot>({
    queryKey: coordinationQueryKey(sessionId),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const [driverLease, presence] = await Promise.all([
        getDriverLease(sessionId, { signal }),
        heartbeatPresence(sessionId, { signal }),
      ]);
      return { driverLease, presence };
    },
    refetchInterval: COORDINATION_REFRESH_INTERVAL_MS,
    refetchOnReconnect: "always",
    retry: false,
    staleTime: COORDINATION_REFRESH_INTERVAL_MS,
    structuralSharing: (current, incoming) =>
      mergeCoordinationSnapshot(
        current as CoordinationSnapshot | undefined,
        incoming as CoordinationSnapshot,
      ),
  });

  const refresh = useCallback(async () => {
    const result = await query.refetch({ cancelRefetch: true });
    if (result.error) {
      setRefreshFailure({ error: result.error, dataUpdatedAt: query.dataUpdatedAt });
      throw result.error;
    }
    setRefreshFailure(null);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void resolveIdentity().then((userId) => {
      if (!cancelled) setViewer({ loaded: true, userId });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      setOfflineRecoveryTimestamp(query.dataUpdatedAt);
    } else if (
      offlineRecoveryTimestamp !== null &&
      query.dataUpdatedAt > offlineRecoveryTimestamp &&
      !query.isFetching &&
      !query.isError
    ) {
      setOfflineRecoveryTimestamp(null);
    }
  }, [isOnline, offlineRecoveryTimestamp, query.dataUpdatedAt, query.isError, query.isFetching]);

  useEffect(() => {
    if (refreshFailure && query.dataUpdatedAt > refreshFailure.dataUpdatedAt) {
      setRefreshFailure(null);
    }
  }, [query.dataUpdatedAt, refreshFailure]);

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
  const handleLeaseSuccess = useCallback(
    (lease: DriverLease, _variables: unknown, actionId: number | undefined) => {
      if (actionId === actionSequence.current) setActionError(null);
      settleLease(lease);
      void queryClient.invalidateQueries({ queryKey: coordinationAuditQueryKey(sessionId) });
    },
    [queryClient, sessionId, settleLease],
  );
  const handleLeaseError = useCallback(
    (mutationError: Error, _variables: unknown, actionId: number | undefined) => {
      reconcileConflict(mutationError);
      if (actionId === actionSequence.current) {
        setActionError(mutationError);
      }
    },
    [reconcileConflict],
  );
  const beginAction = useCallback(() => {
    actionSequence.current += 1;
    setActionError(null);
    return actionSequence.current;
  }, []);

  const acquireMutation = useMutation({
    mutationFn: (options: AcquireDriverLeaseOptions = {}) => acquireDriverLease(sessionId, options),
    onMutate: beginAction,
    onSuccess: handleLeaseSuccess,
    onError: handleLeaseError,
  });
  const renewMutation = useMutation({
    mutationFn: (options: GenerationLeaseOptions) => renewDriverLease(sessionId, options),
    onMutate: beginAction,
    onSuccess: handleLeaseSuccess,
    onError: handleLeaseError,
  });
  const releaseMutation = useMutation({
    mutationFn: (options: GenerationLeaseOptions) => releaseDriverLease(sessionId, options),
    onMutate: beginAction,
    onSuccess: handleLeaseSuccess,
    onError: handleLeaseError,
  });
  const handoffMutation = useMutation({
    mutationFn: (options: HandoffDriverLeaseOptions) => handoffDriverLease(sessionId, options),
    onMutate: beginAction,
    onSuccess: handleLeaseSuccess,
    onError: handleLeaseError,
  });

  const driverLease = query.data?.driverLease ?? null;
  const currentDriverUserId =
    driverLease?.active === true ? (driverLease.holderUserId ?? null) : null;
  const expectedDriverUserId = viewer.loaded ? (viewer.userId ?? PUBLIC_DRIVER_USER_ID) : null;
  const refreshError = refreshFailure?.error ?? null;
  const connectionState: CoordinationConnectionState =
    !isOnline || query.fetchStatus === "paused"
      ? "offline"
      : query.data === undefined && query.isFetching
        ? "connecting"
        : (refreshError !== null || query.isError) && !query.isFetching
          ? "error"
          : offlineRecoveryTimestamp !== null ||
              (query.isFetching && (refreshError !== null || query.isRefetchError))
            ? "reconnecting"
            : "connected";
  return {
    driverLease,
    presence: query.data?.presence ?? null,
    connectionState,
    error: refreshError ?? query.error,
    isLoading: query.isPending,
    isRefreshing: query.data !== undefined && query.isFetching,
    isStale: query.data !== undefined && connectionState !== "connected",
    updatedAt: query.dataUpdatedAt || null,
    activeParticipantIds: query.data?.presence?.activeUserIds ?? [],
    participants: query.data?.presence?.entries ?? [],
    currentDriverUserId,
    isCurrentUserDriver:
      currentDriverUserId !== null && currentDriverUserId === expectedDriverUserId,
    isActionPending:
      acquireMutation.isPending ||
      renewMutation.isPending ||
      releaseMutation.isPending ||
      handoffMutation.isPending,
    actionError,
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
  isFetching: boolean;
  isStale: boolean;
  error: Error | null;
  refresh(): Promise<void>;
}

export function useCoordinationAudit(sessionId: string): UseCoordinationAuditResult {
  const query = useQuery({
    queryKey: coordinationAuditQueryKey(sessionId),
    queryFn: ({ signal }) => listCoordinationAudit(sessionId, { signal }),
    retry: false,
  });
  return {
    records: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isStale: query.isStale,
    error: query.error,
    refresh: async () => {
      await query.refetch();
    },
  };
}

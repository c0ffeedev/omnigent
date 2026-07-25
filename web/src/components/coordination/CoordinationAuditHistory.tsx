import { useInfiniteQuery } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fetchCoordinationAuditPage, type CoordinationAuditRecord } from "@/lib/coordinationApi";
import { absoluteTime, relativeTime } from "@/lib/relativeTime";
import { ApiError } from "@/lib/sessionsApi";
import { cn } from "@/lib/utils";

const ACTIVITY_PAGE_SIZE = 20;

function actorName(record: CoordinationAuditRecord): string {
  return record.actorUserId ?? "Unknown actor";
}

function describeActivity(record: CoordinationAuditRecord): string {
  const actor = actorName(record);
  switch (record.eventType) {
    case "session.driver_lease.acquired":
      return `${actor} took control`;
    case "session.driver_lease.renewed":
      return `${actor} renewed control`;
    case "session.driver_lease.released":
      return `${actor} released control`;
    case "session.driver_lease.handed_off":
      return record.holderUserId
        ? `${actor} handed control to ${record.holderUserId}`
        : `${actor} handed off control`;
    default: {
      const action = record.eventType.split(".").at(-1)?.replaceAll("_", " ");
      return `${actor} changed session control${action ? ` (${action})` : ""}`;
    }
  }
}

function displayRelativeTime(timestamp: number): string {
  const value = relativeTime(timestamp);
  return value === "now" ? value : `${value} ago`;
}

function displayOutcome(outcome: string): string {
  return outcome.replaceAll("_", " ").replaceAll("-", " ");
}

function ActivityRow({ record }: { record: CoordinationAuditRecord }) {
  const hasTime = record.createdAt !== null && Number.isFinite(record.createdAt);
  const timestampMs = hasTime ? (record.createdAt as number) * 1_000 : null;
  return (
    <li className="grid gap-1 border-b border-border/60 py-3 last:border-b-0">
      <p className="break-words text-sm font-medium text-foreground">{describeActivity(record)}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {record.outcome !== null && <span>Outcome: {displayOutcome(record.outcome)}</span>}
        {record.generation !== null && <span>Generation {record.generation}</span>}
        {hasTime ? (
          <>
            <time dateTime={new Date(timestampMs as number).toISOString()}>
              {displayRelativeTime(timestampMs as number)}
            </time>
            <span aria-hidden="true">·</span>
            <span>{absoluteTime(timestampMs as number)}</span>
          </>
        ) : (
          <span>Time unavailable</span>
        )}
      </div>
    </li>
  );
}

function LoadingActivity() {
  return (
    <div role="status" aria-live="polite" className="grid gap-3 py-3">
      <span className="sr-only">Loading activity</span>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden="true" className="grid animate-pulse gap-2">
          <div className="h-3 w-3/4 rounded bg-muted" />
          <div className="h-2 w-1/2 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ActivityError({
  error,
  retry,
  partial = false,
}: {
  error: Error;
  retry: () => void;
  partial?: boolean;
}) {
  const permissionDenied =
    error instanceof ApiError && (error.status === 401 || error.status === 403);
  const title = permissionDenied
    ? "You do not have permission to view coordination activity"
    : partial
      ? "Some activity could not be loaded"
      : "Activity history could not be loaded";
  return (
    <div
      role="alert"
      className="grid gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
    >
      <div>
        <p className="font-medium text-destructive">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {permissionDenied
            ? "Ask a session owner for access."
            : partial
              ? `Showing the activity loaded so far. ${error.message}`
              : error.message}
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

export interface CoordinationAuditHistoryProps {
  sessionId: string;
  className?: string;
}

/** Paginated, read-only projection of server-persisted coordination events. */
export function CoordinationAuditHistory({ sessionId, className }: CoordinationAuditHistoryProps) {
  const query = useInfiniteQuery({
    queryKey: ["coordination", sessionId, "audit-history"],
    queryFn: ({ pageParam, signal }) =>
      fetchCoordinationAuditPage(sessionId, {
        cursor: pageParam,
        limit: ACTIVITY_PAGE_SIZE,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
    retry: false,
  });

  if (query.isPending) return <LoadingActivity />;
  if (query.isError && query.data === undefined) {
    return <ActivityError error={query.error} retry={() => void query.refetch()} />;
  }

  const records = Array.from(
    new Map(
      (query.data?.pages ?? [])
        .flatMap((page) => page.records)
        .map((record) => [record.id, record]),
    ).values(),
  ).sort((left, right) => (right.createdAt ?? -Infinity) - (left.createdAt ?? -Infinity));

  return (
    <div className={cn("grid min-h-0 gap-3", className)}>
      {records.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center">
          <p className="font-medium">No coordination activity yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Server-recorded control changes will appear here.
          </p>
        </div>
      ) : (
        <ul aria-label="Coordination activity" className="min-w-0">
          {records.map((record) => (
            <ActivityRow key={record.id} record={record} />
          ))}
        </ul>
      )}

      {query.isFetchNextPageError && (
        <ActivityError error={query.error} retry={() => void query.fetchNextPage()} partial />
      )}
      {query.hasNextPage && !query.isFetchNextPageError && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older activity
        </Button>
      )}
    </div>
  );
}

export interface CoordinationAuditHistoryDialogProps {
  sessionId: string;
  className?: string;
}

/** Session-chrome entry point for the bounded coordination history panel. */
export function CoordinationAuditHistoryDialog({
  sessionId,
  className,
}: CoordinationAuditHistoryDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn("h-7", className)}>
          <HistoryIcon aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Activity history</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Coordination activity</DialogTitle>
          <DialogDescription>
            Server-recorded control changes for this session, latest first.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          <CoordinationAuditHistory sessionId={sessionId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

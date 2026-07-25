import {
  AlertTriangleIcon,
  CloudOffIcon,
  CrownIcon,
  Loader2Icon,
  RefreshCwIcon,
  UsersIcon,
  WifiIcon,
} from "lucide-react";
import { useId } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCoordination, type CoordinationConnectionState } from "@/hooks/useCoordination";
import { cn } from "@/lib/utils";
import { userColor, userInitials } from "@/lib/userBadge";

interface CoordinationStatusPopoverProps {
  sessionId: string;
}

type DisplayState = "loading" | "live" | "reconnecting" | "disconnected" | "stale" | "failed";

interface StatusCopy {
  label: string;
  announcement: string;
  dotClassName: string;
}

const STATUS_COPY: Record<DisplayState, StatusCopy> = {
  loading: {
    label: "Loading…",
    announcement: "Loading coordination status",
    dotClassName: "bg-muted-foreground",
  },
  live: {
    label: "Live",
    announcement: "Coordination status is live",
    dotClassName: "bg-emerald-500",
  },
  reconnecting: {
    label: "Reconnecting…",
    announcement: "Reconnecting to coordination updates",
    dotClassName: "animate-pulse bg-amber-500",
  },
  disconnected: {
    label: "Disconnected",
    announcement: "Coordination updates disconnected",
    dotClassName: "bg-destructive",
  },
  stale: {
    label: "Status may be out of date",
    announcement: "Coordination status may be out of date",
    dotClassName: "bg-amber-500",
  },
  failed: {
    label: "Unavailable",
    announcement: "Coordination status failed to load",
    dotClassName: "bg-destructive",
  },
};

function displayStateFor({
  connectionState,
  hasSnapshot,
  isLoading,
  isStale,
}: {
  connectionState: CoordinationConnectionState;
  hasSnapshot: boolean;
  isLoading: boolean;
  isStale: boolean;
}): DisplayState {
  if (isLoading && !hasSnapshot) return "loading";
  if (connectionState === "error" && !hasSnapshot) return "failed";
  if (connectionState === "offline") return "disconnected";
  if (connectionState === "reconnecting" || connectionState === "connecting") {
    return hasSnapshot ? "reconnecting" : "loading";
  }
  if (connectionState === "error" || isStale) return "stale";
  return "live";
}

function statusIcon(state: DisplayState) {
  if (state === "loading" || state === "reconnecting") {
    return <Loader2Icon className="size-3.5 animate-spin" aria-hidden />;
  }
  if (state === "disconnected") return <CloudOffIcon className="size-3.5" aria-hidden />;
  if (state === "stale" || state === "failed") {
    return <AlertTriangleIcon className="size-3.5" aria-hidden />;
  }
  return <WifiIcon className="size-3.5" aria-hidden />;
}

function triggerLabel({
  displayState,
  driverUserId,
  hasSnapshot,
  participantCount,
}: {
  displayState: DisplayState;
  driverUserId: string | null;
  hasSnapshot: boolean;
  participantCount: number;
}): string {
  if (displayState === "loading") return "Coordination status: loading";
  if (displayState === "failed") return "Coordination status: unavailable";
  if (!hasSnapshot) return `Coordination status: ${STATUS_COPY[displayState].label.toLowerCase()}`;
  const isLastKnown = displayState !== "live";
  const participantLabel =
    participantCount === 0
      ? "no participants"
      : `${participantCount} ${isLastKnown ? "last known " : ""}${participantCount === 1 ? "participant" : "participants"}`;
  const driverLabel = driverUserId
    ? isLastKnown
      ? `${driverUserId} was the last known driver`
      : `${driverUserId} is driver`
    : isLastKnown
      ? "no driver in the last known state"
      : "no active driver";
  const stateLabel = STATUS_COPY[displayState].label.toLocaleLowerCase();
  return `Session coordination: ${participantLabel}, ${driverLabel}, ${stateLabel}`;
}

function formatTimestamp(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp * 1_000));
}

function ParticipantAvatar({ userId }: { userId: string }) {
  return (
    <Avatar size="sm" aria-hidden>
      <AvatarFallback
        className="font-semibold text-[10px] text-white"
        style={{ backgroundColor: userColor(userId) }}
      >
        {userInitials(userId)}
      </AvatarFallback>
    </Avatar>
  );
}

export function CoordinationStatusPopover({ sessionId }: CoordinationStatusPopoverProps) {
  const titleId = useId();
  const descriptionId = useId();
  const coordination = useCoordination(sessionId);
  const participantIds = coordination.activeParticipantIds;
  const hasSnapshot = coordination.presence !== null || coordination.updatedAt !== null;
  const displayState = displayStateFor({
    connectionState: coordination.connectionState,
    hasSnapshot,
    isLoading: coordination.isLoading,
    isStale: coordination.isStale,
  });
  const status = STATUS_COPY[displayState];
  const isLastKnown = displayState !== "live";
  const currentDriverUserId = coordination.currentDriverUserId;
  const leaseExpiry = formatTimestamp(coordination.driverLease?.expiresAt ?? null);
  const lastUpdated =
    coordination.updatedAt === null
      ? null
      : new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(coordination.updatedAt));

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status.announcement}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="coordination-status-trigger"
            aria-label={triggerLabel({
              displayState,
              driverUserId: currentDriverUserId,
              hasSnapshot,
              participantCount: participantIds.length,
            })}
            className={cn(
              "flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-muted-foreground text-xs transition-colors",
              "hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <UsersIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular-nums">{participantIds.length}</span>
            <span className="hidden h-3.5 w-px bg-border sm:block" aria-hidden />
            {currentDriverUserId ? (
              <span className="hidden max-w-32 min-w-0 items-center gap-1 sm:flex">
                <CrownIcon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  {isLastKnown ? `Last: ${currentDriverUserId}` : currentDriverUserId}
                </span>
              </span>
            ) : (
              <span className="hidden whitespace-nowrap sm:inline">
                {isLastKnown ? "Last: no driver" : "No driver"}
              </span>
            )}
            <span
              className={cn("ml-0.5 size-2 shrink-0 rounded-full", status.dotClassName)}
              aria-hidden
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-1rem))] gap-0 overflow-y-auto p-0"
          data-testid="coordination-status-popover"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <h2 id={titleId} className="font-medium text-sm">
                Session coordination
              </h2>
              <PopoverDescription id={descriptionId} className="mt-0.5 text-xs">
                Presence and driver ownership for this session
              </PopoverDescription>
            </div>
            <div
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 font-medium text-xs",
                displayState === "live"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : displayState === "stale" || displayState === "reconnecting"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : displayState === "loading"
                      ? "bg-muted text-muted-foreground"
                      : "bg-destructive/10 text-destructive",
              )}
            >
              {statusIcon(displayState)}
              {status.label}
            </div>
          </div>

          {displayState === "loading" ? (
            <div className="flex items-center gap-2 px-3 py-5 text-muted-foreground text-sm">
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              Loading coordination status…
            </div>
          ) : displayState === "failed" ? (
            <div className="space-y-3 px-3 py-4">
              <div>
                <p className="font-medium text-sm">Couldn’t load coordination status</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {coordination.error?.message ?? "The coordination service is unavailable."}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="Retry coordination status"
                onClick={() => void coordination.refresh().catch(() => undefined)}
              >
                <RefreshCwIcon className="size-3.5" aria-hidden />
                Retry
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              <section className="px-3 py-3" aria-labelledby="coordination-participants-heading">
                <h3
                  id="coordination-participants-heading"
                  className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide"
                >
                  {isLastKnown ? "Last known participants" : "Present"} ({participantIds.length})
                </h3>
                {participantIds.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {!hasSnapshot
                      ? "Participant status is unavailable"
                      : isLastKnown
                        ? "No participants were present when last updated"
                        : "No one is currently present"}
                  </p>
                ) : (
                  <ul
                    className="space-y-1"
                    aria-label={isLastKnown ? "Last known participants" : "Present participants"}
                  >
                    {participantIds.map((userId) => {
                      const isDriver = userId === currentDriverUserId;
                      return (
                        <li
                          key={userId}
                          data-testid={`coordination-participant-${userId}`}
                          data-driver={isDriver ? "true" : "false"}
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5",
                            isDriver && "bg-primary/8 text-foreground ring-1 ring-primary/20",
                          )}
                        >
                          <ParticipantAvatar userId={userId} />
                          <span className="min-w-0 flex-1 truncate text-sm">{userId}</span>
                          {isDriver && (
                            <span className="flex shrink-0 items-center gap-1 text-primary text-xs">
                              <CrownIcon className="size-3.5" aria-hidden />
                              <span className="sr-only">Current driver</span>
                              <span aria-hidden>Driver</span>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                className="space-y-1 px-3 py-3"
                aria-labelledby="coordination-driver-heading"
              >
                <h3
                  id="coordination-driver-heading"
                  className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
                >
                  Driver lease
                </h3>
                {currentDriverUserId ? (
                  <>
                    <p className="truncate font-medium text-sm">{currentDriverUserId}</p>
                    <p className="text-muted-foreground text-xs">
                      {isLastKnown ? "Last known lease: active" : "Lease active"}
                      {leaseExpiry ? ` · expires ${leaseExpiry}` : ""}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {hasSnapshot ? "No active driver" : "Driver status is unavailable"}
                  </p>
                )}
              </section>

              {isLastKnown && (
                <div className="flex items-start gap-2 bg-muted/50 px-3 py-2.5 text-muted-foreground text-xs">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Displayed participants and lease are last known, not current.
                    {lastUpdated ? ` Last updated at ${lastUpdated}.` : ""}
                  </span>
                </div>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

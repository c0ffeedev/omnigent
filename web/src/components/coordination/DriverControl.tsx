import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangleIcon, ArrowRightLeftIcon, CircleDotIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCoordination } from "@/hooks/useCoordination";
import { usePermissions } from "@/hooks/usePermissions";
import { CoordinationApiError, DriverLeaseConflictError } from "@/lib/coordinationApi";

const LEVEL_EDIT = 2;
const LEVEL_MANAGE = 3;
const ACTION_TIMEOUT_MS = 10_000;

type Feedback = { kind: "error" | "success"; message: string };
type Confirmation =
  | {
      action: "handoff";
      generation: number;
      holderUserId: string | null;
      targetUserId: string;
    }
  | {
      action: "release";
      generation: number;
      holderUserId: string;
    };

function displayIdentity(userId: string | null): string {
  if (userId === null) return "an unknown driver";
  return userId === "__public__" ? "the local user" : userId;
}

async function runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout = 0;
  const timeoutRequest = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(() => {
      controller.abort();
      reject(new Error("The request timed out."));
    }, ACTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutRequest]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("The request timed out.", { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function failureMessage(error: unknown, refreshFailed: boolean): string {
  const refreshSuffix = refreshFailed
    ? " Control state could not be refreshed; reconnect before trying again."
    : " The current control state has been refreshed.";
  if (error instanceof DriverLeaseConflictError) {
    const currentHolder =
      error.currentLease?.active === true
        ? error.currentLease.holderUserId
          ? ` Control is now held by ${displayIdentity(error.currentLease.holderUserId)}.`
          : " The active lease does not identify a driver."
        : " There is no active driver now.";
    return `Control changed before the action completed.${currentHolder}${refreshSuffix}`;
  }
  if (error instanceof CoordinationApiError && error.status === 403) {
    return `You no longer have permission to change session control.${refreshSuffix}`;
  }
  if (error instanceof Error && /timed out|network|fetch/i.test(error.message)) {
    return `The control request failed or timed out and may not have reached the server.${refreshSuffix}`;
  }
  return `The control request failed.${refreshSuffix}`;
}

export interface DriverControlProps {
  sessionId: string;
  permissionLevel: number | null;
}

/** Visible, fenced controls for collaborative session-driver ownership. */
export function DriverControl({ sessionId, permissionLevel }: DriverControlProps) {
  const coordination = useCoordination(sessionId);
  const canEdit = permissionLevel === null || permissionLevel >= LEVEL_EDIT;
  // Permission-list lookup is unavailable when permissions are disabled, so
  // single-user mode keeps edit recovery but omits meaningless handoff UI.
  const canManageHandoffs = permissionLevel !== null && permissionLevel >= LEVEL_MANAGE;
  const permissions = usePermissions(canManageHandoffs ? sessionId : null);
  const [selectedTarget, setSelectedTarget] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const pendingRef = useRef(false);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const lease = coordination.driverLease;
  const activeLease = lease?.active === true ? lease : null;
  const holderUserId = activeLease?.holderUserId ?? null;
  const activeParticipantIds = coordination.presence?.activeUserIds;
  const editableUsers = useMemo(
    () =>
      new Set(
        (permissions.data ?? []).filter((grant) => grant.level >= LEVEL_EDIT).map((g) => g.user_id),
      ),
    [permissions.data],
  );
  const handoffCandidates = useMemo(
    () =>
      (activeParticipantIds ?? []).filter(
        (userId) => userId !== holderUserId && editableUsers.has(userId),
      ),
    [activeParticipantIds, editableUsers, holderUserId],
  );

  useEffect(() => {
    if (selectedTarget && !handoffCandidates.includes(selectedTarget)) setSelectedTarget("");
  }, [handoffCandidates, selectedTarget]);

  const stateUnavailable =
    coordination.connectionState !== "connected" || coordination.error !== null;
  const actionPending = localPending;
  const actionsDisabled = stateUnavailable || refreshPending || actionPending;
  const confirmationIsCurrent =
    confirmation !== null &&
    lease?.active === true &&
    lease.generation === confirmation.generation &&
    holderUserId === confirmation.holderUserId &&
    (confirmation.action === "release" ||
      (!permissions.isError && handoffCandidates.includes(confirmation.targetUserId)));

  useEffect(() => {
    if (confirmation && !actionPending && !confirmationIsCurrent) {
      setConfirmation(null);
      setFeedback({
        kind: "error",
        message:
          "Control changed while confirmation was open. Review the current driver before trying again.",
      });
    }
  }, [actionPending, confirmation, confirmationIsCurrent]);

  const hasCollaborationContext = (activeParticipantIds?.length ?? 0) > 1 || activeLease !== null;
  if (!hasCollaborationContext && !coordination.error) return null;

  const refreshState = async () => {
    setFeedback(null);
    setRefreshPending(true);
    try {
      await coordination.refresh();
    } catch {
      setFeedback({
        kind: "error",
        message: "Control state could not be refreshed. Check the connection and try again.",
      });
    } finally {
      setRefreshPending(false);
    }
  };

  const runAction = async (
    operation: (signal: AbortSignal) => Promise<unknown>,
    successMessage: string,
  ) => {
    if (pendingRef.current || actionsDisabled) return;
    pendingRef.current = true;
    setLocalPending(true);
    setFeedback(null);
    try {
      await runWithTimeout(operation);
      setFeedback({ kind: "success", message: successMessage });
      setConfirmation(null);
    } catch (error) {
      let refreshFailed = false;
      try {
        await coordination.refresh();
      } catch {
        refreshFailed = true;
      }
      setFeedback({ kind: "error", message: failureMessage(error, refreshFailed) });
      setConfirmation(null);
    } finally {
      pendingRef.current = false;
      setLocalPending(false);
    }
  };

  const confirmAction = () => {
    if (!confirmation || !confirmationIsCurrent || actionsDisabled) return;
    if (confirmation.action === "handoff") {
      const target = confirmation.targetUserId;
      void runAction(
        (signal) =>
          coordination.handoff({
            generation: confirmation.generation,
            holderUserId: target,
            signal,
          }),
        `Control transferred to ${displayIdentity(target)}.`,
      );
      return;
    }
    void runAction(
      (signal) => coordination.release({ generation: confirmation.generation, signal }),
      "Control released. Another editor can now take control.",
    );
  };

  const statusText = activeLease
    ? holderUserId
      ? coordination.isCurrentUserDriver
        ? "You have control"
        : `${displayIdentity(holderUserId)} has control`
      : "Active driver unavailable"
    : "No active driver";

  return (
    <section
      ref={sectionRef}
      data-testid="driver-control"
      aria-label="Session control"
      tabIndex={-1}
      className="mx-auto mb-2 flex w-[calc(100%-2rem)] max-w-3xl flex-col gap-2 rounded-xl border border-border bg-card/80 px-3 py-2 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CircleDotIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{statusText}</span>
        {holderUserId && !coordination.isCurrentUserDriver && (
          <span className="text-muted-foreground">
            Only the active driver can start agent work.
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!activeLease && canEdit && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={actionsDisabled}
              loading={actionPending}
              onClick={() =>
                void runAction(
                  (signal) => coordination.acquire({ force: false, signal }),
                  "You now have control.",
                )
              }
            >
              Take control
            </Button>
          )}
          {activeLease && coordination.isCurrentUserDriver && canEdit && lease && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={actionsDisabled}
              onClick={(event) => {
                lastTriggerRef.current = event.currentTarget;
                setConfirmation({
                  action: "release",
                  generation: lease.generation,
                  holderUserId: holderUserId!,
                });
              }}
            >
              Release control
            </Button>
          )}
          {activeLease && canManageHandoffs && lease && (
            <>
              <Select
                value={selectedTarget}
                onValueChange={setSelectedTarget}
                disabled={
                  actionsDisabled ||
                  permissions.isLoading ||
                  permissions.isError ||
                  handoffCandidates.length === 0
                }
              >
                <SelectTrigger size="sm" aria-label="Transfer control to">
                  <SelectValue
                    placeholder={permissions.isLoading ? "Loading editors…" : "Choose editor"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {handoffCandidates.map((userId) => (
                    <SelectItem key={userId} value={userId}>
                      {displayIdentity(userId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                disabled={actionsDisabled || !selectedTarget}
                onClick={(event) => {
                  lastTriggerRef.current = event.currentTarget;
                  setConfirmation({
                    action: "handoff",
                    generation: lease.generation,
                    holderUserId,
                    targetUserId: selectedTarget,
                  });
                }}
              >
                <ArrowRightLeftIcon aria-hidden="true" />
                Transfer
              </Button>
            </>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh control state"
            disabled={refreshPending || actionPending}
            onClick={() => void refreshState()}
          >
            <RefreshCwIcon className={refreshPending ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {stateUnavailable && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Control state may be out of date</AlertTitle>
          <AlertDescription>
            Reconnect or refresh before changing control. No control action will run while this
            state is stale.
          </AlertDescription>
        </Alert>
      )}
      {permissions.isError && canManageHandoffs && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Editors could not be verified</AlertTitle>
          <AlertDescription>
            Transfer is unavailable until the session permission list can be refreshed.
          </AlertDescription>
        </Alert>
      )}
      {feedback && (
        <div
          role={feedback.kind === "error" ? "alert" : "status"}
          aria-live={feedback.kind === "error" ? "assertive" : "polite"}
          className={
            feedback.kind === "error" ? "text-destructive text-sm" : "text-muted-foreground text-sm"
          }
        >
          {feedback.message}
        </div>
      )}

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !actionPending) setConfirmation(null);
        }}
      >
        <DialogContent
          showCloseButton={!actionPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = lastTriggerRef.current;
            if (trigger?.isConnected) trigger.focus();
            else sectionRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "handoff"
                ? "Transfer session control?"
                : "Release session control?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "handoff"
                ? "Control transfers immediately. Review the current and new driver before continuing."
                : "The session will have no active driver until an editor takes control."}
            </DialogDescription>
          </DialogHeader>
          {confirmation?.action === "handoff" && (
            <dl className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Current driver</dt>
                <dd className="truncate font-medium">
                  {displayIdentity(confirmation.holderUserId)}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">Transfer to</dt>
                <dd className="truncate font-medium">
                  {displayIdentity(confirmation.targetUserId)}
                </dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={actionPending}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={actionsDisabled || !confirmationIsCurrent}
              loading={actionPending}
              onClick={confirmAction}
            >
              {confirmation?.action === "handoff" ? "Transfer control" : "Release control"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

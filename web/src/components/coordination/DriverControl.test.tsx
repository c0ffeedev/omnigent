import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseCoordinationResult } from "@/hooks/useCoordination";
import {
  CoordinationApiError,
  DriverLeaseConflictError,
  type DriverLease,
} from "@/lib/coordinationApi";
import { DriverControl } from "./DriverControl";

const useCoordinationMock = vi.fn<(sessionId: string) => UseCoordinationResult>();
const usePermissionsMock = vi.fn();

vi.mock("@/hooks/useCoordination", () => ({
  useCoordination: (sessionId: string) => useCoordinationMock(sessionId),
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: (sessionId: string | null) => usePermissionsMock(sessionId),
}));

const activeLease: DriverLease = {
  sessionId: "sess-1",
  holderUserId: "alice@example.com",
  generation: 7,
  acquiredAt: 10,
  renewedAt: 11,
  expiresAt: 100,
  releasedAt: null,
  active: true,
};

function coordination(overrides: Partial<UseCoordinationResult> = {}): UseCoordinationResult {
  return {
    driverLease: activeLease,
    presence: {
      sessionId: "sess-1",
      activeUserIds: ["alice@example.com", "manager@example.com", "carol@example.com"],
      entries: [],
    },
    connectionState: "connected",
    error: null,
    isLoading: false,
    isRefreshing: false,
    isStale: false,
    updatedAt: 1,
    activeParticipantIds: ["alice@example.com", "manager@example.com", "carol@example.com"],
    participants: [],
    currentDriverUserId: "alice@example.com",
    isCurrentUserDriver: false,
    isActionPending: false,
    actionError: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    acquire: vi.fn().mockResolvedValue(activeLease),
    renew: vi.fn().mockResolvedValue(activeLease),
    release: vi.fn().mockResolvedValue(activeLease),
    handoff: vi
      .fn()
      .mockResolvedValue({ ...activeLease, holderUserId: "carol@example.com", generation: 8 }),
    ...overrides,
  };
}

function permissions() {
  return {
    data: [
      { user_id: "alice@example.com", conversation_id: "sess-1", level: 4 },
      { user_id: "manager@example.com", conversation_id: "sess-1", level: 3 },
      { user_id: "carol@example.com", conversation_id: "sess-1", level: 2 },
      { user_id: "reader@example.com", conversation_id: "sess-1", level: 1 },
    ],
    isLoading: false,
    isError: false,
  };
}

async function chooseCarolAndOpenConfirmation() {
  fireEvent.click(screen.getByRole("combobox", { name: "Transfer control to" }));
  fireEvent.click(await screen.findByRole("option", { name: "carol@example.com" }));
  const transferTrigger = screen.getByRole("button", { name: "Transfer" });
  fireEvent.click(transferTrigger);
  await screen.findByRole("dialog", { name: "Transfer session control?" });
  expect(screen.getByRole("dialog")).toHaveTextContent("Control transfers immediately");
  expect(screen.getByRole("dialog")).toHaveTextContent("Current driveralice@example.com");
  expect(screen.getByRole("dialog")).toHaveTextContent("Transfer tocarol@example.com");
  return transferTrigger;
}

describe("DriverControl", () => {
  beforeEach(() => {
    useCoordinationMock.mockReset();
    usePermissionsMock.mockReset();
    usePermissionsMock.mockReturnValue(permissions());
  });

  it("requires explicit confirmation and submits a generation-fenced handoff", async () => {
    const state = coordination();
    useCoordinationMock.mockReturnValue(state);
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Transfer control" }));

    await waitFor(() => expect(state.handoff).toHaveBeenCalledTimes(1));
    expect(state.handoff).toHaveBeenCalledWith({
      generation: 7,
      holderUserId: "carol@example.com",
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Control transferred to carol@example.com",
    );
  });

  it("blocks duplicate submissions while a handoff is pending", async () => {
    let finish!: (lease: DriverLease) => void;
    const handoff = vi.fn().mockReturnValue(
      new Promise<DriverLease>((resolve) => {
        finish = resolve;
      }),
    );
    const state = coordination({ handoff });
    useCoordinationMock.mockReturnValue(state);
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    const confirm = screen.getByRole("button", { name: "Transfer control" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(handoff).toHaveBeenCalledTimes(1);
    finish({ ...activeLease, holderUserId: "carol@example.com", generation: 8 });
    expect(await screen.findByText(/Control transferred to carol@example.com/)).toBeInTheDocument();
  });

  it("reconciles a generation conflict and explains how to retry safely", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const currentLease = { ...activeLease, holderUserId: "dana@example.com", generation: 8 };
    const state = coordination({
      refresh,
      handoff: vi
        .fn()
        .mockRejectedValue(
          new DriverLeaseConflictError("Driver generation mismatch", currentLease),
        ),
    });
    useCoordinationMock.mockReturnValue(state);
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Transfer control" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Control changed before the action completed. Control is now held by dana@example.com",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "Transfer control to" })).toHaveTextContent(
      "carol@example.com",
    );
  });

  it("surfaces network failures and refresh failures without retrying the mutation", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const handoff = vi.fn().mockRejectedValue(new Error("Network request failed"));
    useCoordinationMock.mockReturnValue(coordination({ refresh, handoff }));
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Transfer control" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may not have reached the server. Control state could not be refreshed",
    );
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("reports a backend permission rejection and refreshes authoritative state", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const handoff = vi
      .fn()
      .mockRejectedValue(new CoordinationApiError("Forbidden", 403, "forbidden"));
    useCoordinationMock.mockReturnValue(coordination({ refresh, handoff }));
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Transfer control" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You no longer have permission to change session control",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out handoff and requires an authoritative refresh before retry", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const handoff = vi.fn(() => new Promise<DriverLease>(() => undefined));
    useCoordinationMock.mockReturnValue(coordination({ refresh, handoff }));
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await chooseCarolAndOpenConfirmation();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Transfer control" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    vi.useRealTimers();

    expect(screen.getByRole("alert")).toHaveTextContent("failed or timed out");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("closes a stale confirmation without submitting and returns focus to the trigger", async () => {
    let state = coordination();
    useCoordinationMock.mockImplementation(() => state);
    const { rerender } = render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    const transferTrigger = await chooseCarolAndOpenConfirmation();
    state = coordination({
      driverLease: { ...activeLease, holderUserId: "dana@example.com", generation: 8 },
      currentDriverUserId: "dana@example.com",
    });
    rerender(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Control changed while confirmation was open",
    );
    expect(state.handoff).not.toHaveBeenCalled();
    await waitFor(() => expect(transferTrigger).toHaveFocus());
  });

  it("returns keyboard focus to the transfer trigger after cancellation", async () => {
    useCoordinationMock.mockReturnValue(coordination());
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    const transferTrigger = await chooseCarolAndOpenConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(transferTrigger).toHaveFocus();
  });

  it("disables every mutation while control state is stale", () => {
    useCoordinationMock.mockReturnValue(
      coordination({ connectionState: "reconnecting", isRefreshing: true, isStale: true }),
    );
    render(<DriverControl sessionId="sess-1" permissionLevel={3} />);

    expect(screen.getByText("Control state may be out of date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh control state" })).toBeDisabled();
  });

  it("does not expose control mutations to a read-only participant", () => {
    useCoordinationMock.mockReturnValue(coordination());
    render(<DriverControl sessionId="sess-1" permissionLevel={1} />);

    expect(screen.getByText("alice@example.com has control")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release control" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take control" })).not.toBeInTheDocument();
    expect(usePermissionsMock).toHaveBeenCalledWith(null);
  });

  it("uses non-forced acquire only when no active driver exists", async () => {
    const acquire = vi.fn().mockResolvedValue({
      ...activeLease,
      holderUserId: "manager@example.com",
      generation: 8,
    });
    useCoordinationMock.mockReturnValue(
      coordination({
        driverLease: { ...activeLease, holderUserId: null, active: false },
        currentDriverUserId: null,
        acquire,
      }),
    );
    render(<DriverControl sessionId="sess-1" permissionLevel={2} />);

    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    expect(acquire).toHaveBeenCalledWith({ force: false, signal: expect.any(AbortSignal) });
    expect(await screen.findByRole("status")).toHaveTextContent("You now have control");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCoordination } from "@/hooks/useCoordination";
import type { CoordinationSnapshot } from "@/hooks/useCoordination";
import { CoordinationStatusPopover } from "./CoordinationStatusPopover";

vi.mock("@/hooks/useCoordination", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useCoordination")>();
  return { ...actual, useCoordination: vi.fn() };
});

const mockUseCoordination = vi.mocked(useCoordination);

const liveSnapshot: CoordinationSnapshot = {
  presence: {
    sessionId: "sess-1",
    activeUserIds: ["alice@example.com", "bob@example.com"],
    entries: [
      { userId: "alice@example.com", lastSeen: 1_785_000_000, expiresAt: 1_785_000_060 },
      { userId: "bob@example.com", lastSeen: 1_785_000_005, expiresAt: 1_785_000_065 },
    ],
  },
  driverLease: {
    sessionId: "sess-1",
    holderUserId: "bob@example.com",
    generation: 4,
    acquiredAt: 1_785_000_000,
    renewedAt: 1_785_000_005,
    expiresAt: 1_785_000_035,
    releasedAt: null,
    active: true,
  },
};

function coordinationResult(
  overrides: Partial<ReturnType<typeof useCoordination>> = {},
): ReturnType<typeof useCoordination> {
  return {
    ...liveSnapshot,
    connectionState: "connected",
    isCurrentUserDriver: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    acquire: vi.fn(),
    renew: vi.fn(),
    release: vi.fn(),
    handoff: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useCoordination>;
}

function openStatus(): void {
  fireEvent.click(screen.getByTestId("coordination-status-trigger"));
}

beforeEach(() => {
  mockUseCoordination.mockReset();
  mockUseCoordination.mockReturnValue(coordinationResult());
});

describe("CoordinationStatusPopover", () => {
  it("shows an explicit empty presence and no-driver state", () => {
    mockUseCoordination.mockReturnValue(
      coordinationResult({
        presence: { sessionId: "sess-1", activeUserIds: [], entries: [] },
        driverLease: null,
      }),
    );

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(
      screen.getByRole("button", {
        name: /session coordination: no participants, no active driver, live/i,
      }),
    ).toBeVisible();

    openStatus();
    expect(screen.getByText("No one is currently present")).toBeVisible();
    expect(screen.getByText("No active driver")).toBeVisible();
  });

  it("lists multiple participants and highlights the current driver", () => {
    render(<CoordinationStatusPopover sessionId="sess-1" />);
    openStatus();

    expect(screen.getByRole("heading", { name: "Present (2)" })).toBeVisible();
    expect(screen.getByText("alice@example.com")).toBeVisible();
    const driverParticipant = screen.getByTestId("coordination-participant-bob@example.com");
    expect(driverParticipant).toHaveTextContent("bob@example.com");
    expect(driverParticipant).toHaveAttribute("data-driver", "true");
    expect(screen.getByText("Current driver", { selector: ".sr-only" })).toBeInTheDocument();
    expect(screen.getByText(/Lease active/)).toBeVisible();
  });

  it("renders initial loading without claiming presence is current", () => {
    mockUseCoordination.mockReturnValue(
      coordinationResult({
        presence: null,
        driverLease: null,
        connectionState: "connecting",
      }),
    );

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(screen.getByRole("button", { name: /coordination status: loading/i })).toBeVisible();
    openStatus();
    expect(screen.getByText("Loading coordination status…")).toBeVisible();
    expect(screen.queryByRole("heading", { name: /present/i })).not.toBeInTheDocument();
  });

  it("labels cached data as last known when it is stale", () => {
    mockUseCoordination.mockReturnValue(
      coordinationResult({ connectionState: "error", error: new Error("Refresh failed") }),
    );

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(
      screen.getByRole("button", {
        name: /2 last known participants, bob@example.com was the last known driver/i,
      }),
    ).toBeVisible();
    openStatus();

    expect(screen.getByText("Status may be out of date")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Last known participants (2)" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Present (2)" })).not.toBeInTheDocument();
  });

  it("shows reconnecting while treating retained presence as last known", () => {
    mockUseCoordination.mockReturnValue(coordinationResult({ connectionState: "reconnecting" }));

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to coordination updates");
    openStatus();
    expect(screen.getByText("Reconnecting…")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Last known participants (2)" })).toBeVisible();
  });

  it("announces successful recovery without repeating participant changes", () => {
    mockUseCoordination.mockReturnValue(coordinationResult({ connectionState: "reconnecting" }));
    const { rerender } = render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to coordination updates");

    mockUseCoordination.mockReturnValue(coordinationResult({ connectionState: "connected" }));
    rerender(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Coordination status is live");
  });

  it("distinguishes disconnected state and marks retained data as last known", () => {
    mockUseCoordination.mockReturnValue(coordinationResult({ connectionState: "offline" }));

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Coordination updates disconnected");
    openStatus();
    expect(screen.getByText("Disconnected")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Last known participants (2)" })).toBeVisible();
  });

  it("shows a terminal load error and provides a keyboard-accessible retry", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockUseCoordination.mockReturnValue(
      coordinationResult({
        presence: null,
        driverLease: null,
        connectionState: "error",
        error: new Error("Service unavailable"),
        refresh,
      }),
    );

    render(<CoordinationStatusPopover sessionId="sess-1" />);
    openStatus();

    expect(screen.getByText("Couldn’t load coordination status")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry coordination status" });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

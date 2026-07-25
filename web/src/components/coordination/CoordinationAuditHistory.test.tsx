import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchCoordinationAuditPageMock } = vi.hoisted(() => ({
  fetchCoordinationAuditPageMock: vi.fn(),
}));

vi.mock("@/lib/coordinationApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coordinationApi")>()),
  fetchCoordinationAuditPage: fetchCoordinationAuditPageMock,
}));

import type { CoordinationAuditRecord } from "@/lib/coordinationApi";
import { coordinationAuditQueryKey } from "@/lib/coordinationState";
import { ApiError } from "@/lib/sessionsApi";
import {
  CoordinationAuditHistory,
  CoordinationAuditHistoryDialog,
} from "./CoordinationAuditHistory";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function auditRecord(
  id: string,
  eventType: string,
  createdAt: number,
  overrides: Partial<CoordinationAuditRecord> = {},
): CoordinationAuditRecord {
  return {
    id,
    eventType,
    sessionId: "sess-1",
    actorUserId: "alice@example.com",
    holderUserId: "alice@example.com",
    generation: 1,
    outcome: "completed",
    createdAt,
    ...overrides,
  };
}

beforeEach(() => fetchCoordinationAuditPageMock.mockReset());
afterEach(cleanup);

describe("CoordinationAuditHistory", () => {
  it("shows bounded loading and empty states without announcing stale activity", async () => {
    let resolvePage!: (value: { records: []; nextCursor: null }) => void;
    fetchCoordinationAuditPageMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    expect(screen.getByRole("status")).toHaveTextContent("Loading activity");

    resolvePage({ records: [], nextCursor: null });
    expect(await screen.findByText("No coordination activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load older activity/i })).toBeNull();
  });

  it("distinguishes a sparse page from terminal empty history", async () => {
    fetchCoordinationAuditPageMock
      .mockResolvedValueOnce({ records: [], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({
        records: [auditRecord("old", "session.driver_lease.released", 100)],
        nextCursor: null,
      });

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    expect(await screen.findByText("No activity in this page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /load older activity/i }));

    expect(await screen.findByText(/released control/)).toBeInTheDocument();
    expect(screen.queryByText("No activity in this page")).toBeNull();
  });

  it("renders authoritative records newest first with actor, action, target, and time", async () => {
    fetchCoordinationAuditPageMock.mockResolvedValueOnce({
      records: [
        auditRecord("old", "session.driver_lease.acquired", 1_750_000_000),
        auditRecord("new", "session.driver_lease.handed_off", 1_760_000_000, {
          actorUserId: "alice@example.com",
          holderUserId: "bob@example.com",
          generation: 2,
        }),
      ],
      nextCursor: null,
    });

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    const list = await screen.findByRole("list", { name: "Coordination activity" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("alice@example.com handed control to bob@example.com");
    expect(rows[0]).toHaveTextContent("Outcome: completed");
    expect(rows[0]).toHaveTextContent("Generation 2");
    expect(rows[1]).toHaveTextContent("alice@example.com took control");
    expect(rows[0].querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1_760_000_000_000).toISOString(),
    );
    expect(rows[0].querySelector("time")).toHaveTextContent(/ago|now/);
    expect(rows[0]).toHaveTextContent(new Date(1_760_000_000_000).toLocaleString());
  });

  it("labels unavailable actor and record details without inventing values", async () => {
    fetchCoordinationAuditPageMock.mockResolvedValueOnce({
      records: [
        auditRecord("unknown", "session.driver_lease.conflict_observed", 0, {
          actorUserId: null,
          holderUserId: null,
          generation: null,
          outcome: null,
          createdAt: null,
        }),
      ],
      nextCursor: null,
    });

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    const row = await screen.findByRole("listitem");
    expect(row).toHaveTextContent("Unknown actor changed session control (conflict observed)");
    expect(row).toHaveTextContent("Time unavailable");
    expect(row).not.toHaveTextContent("Generation");
    expect(row).not.toHaveTextContent("Outcome");
  });

  it("paginates older activity from the backend cursor and avoids duplicate records", async () => {
    fetchCoordinationAuditPageMock
      .mockResolvedValueOnce({
        records: [auditRecord("new", "session.driver_lease.handed_off", 200)],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        records: [
          auditRecord("new", "session.driver_lease.handed_off", 200),
          auditRecord("old", "session.driver_lease.released", 100),
        ],
        nextCursor: null,
      });

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    await screen.findByText(/handed control/);
    fireEvent.click(screen.getByRole("button", { name: /load older activity/i }));

    await screen.findByText(/released control/);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(fetchCoordinationAuditPageMock).toHaveBeenNthCalledWith(
      2,
      "sess-1",
      expect.objectContaining({ cursor: "cursor-1", signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole("button", { name: /load older activity/i })).toBeNull();
  });

  it("shows actionable failures and retries the failed page", async () => {
    fetchCoordinationAuditPageMock
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce({ records: [], nextCursor: null });

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("history unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No coordination activity yet")).toBeInTheDocument();
    await waitFor(() => expect(fetchCoordinationAuditPageMock).toHaveBeenCalledTimes(2));
  });

  it("shows a specific permission-denied state without exposing the server message", async () => {
    fetchCoordinationAuditPageMock.mockRejectedValueOnce(
      new ApiError("internal policy detail", 403, "forbidden"),
    );

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission to view coordination activity");
    expect(alert).toHaveTextContent("Ask a session owner for access.");
    expect(alert).not.toHaveTextContent("internal policy detail");
  });

  it("keeps loaded records visible when an older page fails", async () => {
    fetchCoordinationAuditPageMock
      .mockResolvedValueOnce({
        records: [auditRecord("new", "session.driver_lease.acquired", 200)],
        nextCursor: "cursor-1",
      })
      .mockRejectedValueOnce(new Error("older page unavailable"));

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper });
    await screen.findByText(/took control/);
    fireEvent.click(screen.getByRole("button", { name: /load older activity/i }));

    const alert = await screen.findByRole("alert");
    expect(screen.getByText(/took control/)).toBeInTheDocument();
    expect(alert).toHaveTextContent("Some activity could not be loaded");
    expect(alert).toHaveTextContent("Showing the activity loaded so far");
  });

  it("keeps loaded records visible and surfaces permission loss on refresh", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const localWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    fetchCoordinationAuditPageMock
      .mockResolvedValueOnce({
        records: [auditRecord("new", "session.driver_lease.acquired", 200)],
        nextCursor: null,
      })
      .mockRejectedValueOnce(new ApiError("internal policy detail", 403, "forbidden"));

    render(<CoordinationAuditHistory sessionId="sess-1" />, { wrapper: localWrapper });
    await screen.findByText(/took control/);
    await act(async () => {
      await client.invalidateQueries({
        queryKey: [...coordinationAuditQueryKey("sess-1"), "history"],
      });
    });

    const alert = await screen.findByRole("alert");
    expect(screen.getByText(/took control/)).toBeInTheDocument();
    expect(alert).toHaveTextContent("You do not have permission to view coordination activity");
    expect(alert).not.toHaveTextContent("internal policy detail");
  });
});

describe("CoordinationAuditHistoryDialog", () => {
  it("provides an easy keyboard-named route from session chrome to history", async () => {
    fetchCoordinationAuditPageMock.mockResolvedValueOnce({ records: [], nextCursor: null });
    render(<CoordinationAuditHistoryDialog sessionId="sess-1" />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Activity history" }));
    const dialog = await screen.findByRole("dialog", { name: "Coordination activity" });
    expect(within(dialog).getByText(/server-recorded control changes/i)).toBeInTheDocument();
  });
});

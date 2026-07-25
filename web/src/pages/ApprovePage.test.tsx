// Tests for the standalone URL-mode ApprovePage
// (`/approve/:sessionId/:elicitationId`). The page is driven entirely by a
// `authenticatedFetch` for the initial GET and `postCoordinatedEvent` for the
// fenced approval event. Route params come from react-router (a real
// MemoryRouter + Route supplies them, since `@/lib/routing` falls back to
// react-router-dom). Each test pins one of the page's state-machine branches:
// loading, pending, resolved, submitted (approve/reject), and the error paths
// (bad status, network throw, missing params).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovePage } from "./ApprovePage";
import * as coordinatedEvents from "@/lib/coordinatedEvents";
import * as identity from "@/lib/identity";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock("@/lib/coordinatedEvents", () => ({
  nextDriverSourceId: vi.fn(() => "web:test:approval:1"),
  postCoordinatedEvent: vi.fn(),
}));

/** A Response-like stub: only `ok`, `status`, and `json()` are read. */
function jsonResponse(body: unknown, { ok = true, status = 200 } = {}): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Render the page at a concrete `/approve/:sessionId/:elicitationId` route. */
function renderPage(sessionId = "sess_1", elicitationId = "eli_1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/approve/${sessionId}/${elicitationId}`]}>
        <Routes>
          <Route path="/approve/:sessionId/:elicitationId" element={<ApprovePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApprovePage states", () => {
  beforeEach(() => {
    vi.mocked(coordinatedEvents.postCoordinatedEvent).mockResolvedValue({ queued: false });
    // Default: a never-resolving fetch so the initial render is observable
    // before any test overrides the resolution.
    vi.mocked(identity.authenticatedFetch).mockReturnValue(new Promise(() => {}));
  });

  it("shows a loading state while the elicitation fetch is in flight", () => {
    // WHY: the `loading` branch renders until the GET settles.
    renderPage();
    expect(screen.getByText("Loading elicitation…")).toBeInTheDocument();
  });

  it("renders approve/reject controls plus message and preview when pending", async () => {
    // WHY: the `pending` branch shows the prompt body, policy/phase chips,
    // formatted preview, and both action buttons.
    vi.mocked(identity.authenticatedFetch).mockResolvedValue(
      jsonResponse({
        status: "pending",
        message: "Delete the production database?",
        phase: "pre",
        policy_name: "danger-policy",
        content_preview: "rm -rf /data",
      }),
    );
    renderPage();
    expect(await screen.findByText("Delete the production database?")).toBeInTheDocument();
    expect(screen.getByText("· danger-policy")).toBeInTheDocument();
    expect(screen.getByText("(pre)")).toBeInTheDocument();
    expect(screen.getByText(/rm -rf \/data/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeInTheDocument();
  });

  it("shows the resolved state when the elicitation is no longer pending", async () => {
    // WHY: a `status: "resolved"` payload means the prompt was already
    // resolved/timed-out/cancelled — no buttons, just an informational alert.
    vi.mocked(identity.authenticatedFetch).mockResolvedValue(jsonResponse({ status: "resolved" }));
    renderPage();
    expect(await screen.findByText("Elicitation resolved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("surfaces a server error when the GET returns a non-ok status", async () => {
    // WHY: a non-ok response routes to the `error` branch with the HTTP status.
    vi.mocked(identity.authenticatedFetch).mockResolvedValue(
      jsonResponse(null, { ok: false, status: 500 }),
    );
    renderPage();
    expect(await screen.findByText("Server error: 500")).toBeInTheDocument();
  });

  it("surfaces a load error when the GET rejects", async () => {
    // WHY: a thrown fetch (network failure) routes to the `error` branch.
    vi.mocked(identity.authenticatedFetch).mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByText(/Failed to load:/)).toBeInTheDocument();
  });
});

describe("ApprovePage submission", () => {
  beforeEach(() => {
    vi.mocked(coordinatedEvents.postCoordinatedEvent).mockResolvedValue({ queued: false });
    vi.mocked(identity.authenticatedFetch).mockResolvedValue(
      jsonResponse({ status: "pending", message: "Run the migration?" }),
    );
  });

  it("approves: posts a fenced accept event and shows the Approved confirmation", async () => {
    renderPage("sess_a", "eli_a");
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));

    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
    expect(coordinatedEvents.postCoordinatedEvent).toHaveBeenCalledWith(
      expect.any(QueryClient),
      "sess_a",
      { type: "approval", data: { elicitation_id: "eli_a", action: "accept" } },
      "web:test:approval:1",
    );
  });

  it("rejects: posts a fenced decline event and shows the Rejected confirmation", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));

    await waitFor(() => expect(screen.getByText("Rejected")).toBeInTheDocument());
    expect(coordinatedEvents.postCoordinatedEvent).toHaveBeenCalledWith(
      expect.any(QueryClient),
      "sess_1",
      { type: "approval", data: { elicitation_id: "eli_1", action: "decline" } },
      "web:test:approval:1",
    );
  });

  it("shows an error when the coordinated approval is rejected", async () => {
    vi.mocked(coordinatedEvents.postCoordinatedEvent).mockRejectedValueOnce(
      new Error("Driver lease conflict: 409"),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    expect(await screen.findByText(/Driver lease conflict: 409/)).toBeInTheDocument();
  });

  it("shows a network error when the coordinated event throws", async () => {
    vi.mocked(coordinatedEvents.postCoordinatedEvent).mockRejectedValueOnce(new Error("boom"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));
    expect(await screen.findByText(/Network error:/)).toBeInTheDocument();
  });
});

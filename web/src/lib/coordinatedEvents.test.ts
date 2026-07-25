import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { coordinationQueryKey } from "./coordinationState";

const { getDriverLeaseMock, postEventMock } = vi.hoisted(() => ({
  getDriverLeaseMock: vi.fn(),
  postEventMock: vi.fn(),
}));

vi.mock("./coordinationApi", () => ({ getDriverLease: getDriverLeaseMock }));
vi.mock("./sessionsApi", () => ({ postEvent: postEventMock }));

import { postCoordinatedEvent } from "./coordinatedEvents";

const activeLease = {
  sessionId: "sess-1",
  holderUserId: "alice@example.com",
  generation: 7,
  acquiredAt: 10,
  renewedAt: 11,
  expiresAt: 41,
  releasedAt: null,
  active: true,
};

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  getDriverLeaseMock.mockReset();
  postEventMock.mockReset().mockResolvedValue({ queued: false });
});

describe("postCoordinatedEvent", () => {
  it("adds the cached active generation and stable source id", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(coordinationQueryKey("sess-1"), {
      driverLease: activeLease,
      presence: null,
    });

    await postCoordinatedEvent(
      queryClient,
      "sess-1",
      { type: "message", data: { role: "user", content: [] } },
      "web:client:message:1",
    );

    expect(getDriverLeaseMock).not.toHaveBeenCalled();
    expect(postEventMock).toHaveBeenCalledWith("sess-1", {
      type: "message",
      data: { role: "user", content: [] },
      driver_generation: 7,
      source_id: "web:client:message:1",
    });
  });

  it("replaces a stale cached generation before posting a stop action", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(coordinationQueryKey("sess-1"), {
      driverLease: activeLease,
      presence: null,
    });
    getDriverLeaseMock.mockResolvedValue({ ...activeLease, generation: 12 });

    await postCoordinatedEvent(
      queryClient,
      "sess-1",
      { type: "stop_session", data: {} },
      "web:client:stop-session:1",
    );

    expect(getDriverLeaseMock).toHaveBeenCalledWith("sess-1", {
      signal: expect.any(AbortSignal),
    });
    expect(postEventMock).toHaveBeenCalledWith("sess-1", {
      type: "stop_session",
      data: {},
      driver_generation: 12,
      source_id: "web:client:stop-session:1",
    });
  });

  it("fetches an active lease when the cached approval lease is stale-null", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(coordinationQueryKey("sess-1"), {
      driverLease: null,
      presence: null,
    });
    getDriverLeaseMock.mockResolvedValue({ ...activeLease, generation: 15 });

    await postCoordinatedEvent(
      queryClient,
      "sess-1",
      { type: "approval", data: { elicitation_id: "eli-1", action: "accept" } },
      "web:client:approval:1",
    );

    expect(getDriverLeaseMock).toHaveBeenCalledWith("sess-1", {
      signal: expect.any(AbortSignal),
    });
    expect(postEventMock).toHaveBeenCalledWith("sess-1", {
      type: "approval",
      data: { elicitation_id: "eli-1", action: "accept" },
      driver_generation: 15,
      source_id: "web:client:approval:1",
    });
  });

  it("preserves lease-free event bodies when no driver is active", async () => {
    const queryClient = createQueryClient();
    getDriverLeaseMock.mockResolvedValue(null);
    const event = { type: "stop_session", data: {} };

    await postCoordinatedEvent(queryClient, "sess-1", event, "web:client:stop-session:1");

    expect(postEventMock).toHaveBeenCalledWith("sess-1", event);
  });

  it("does not post an unfenced approval when the lease lookup fails", async () => {
    const queryClient = createQueryClient();
    getDriverLeaseMock.mockRejectedValue(new Error("offline"));

    await expect(
      postCoordinatedEvent(
        queryClient,
        "sess-1",
        { type: "approval", data: { elicitation_id: "eli-1", action: "accept" } },
        "web:client:approval:1",
      ),
    ).rejects.toThrow("offline");

    expect(postEventMock).not.toHaveBeenCalled();
  });
});

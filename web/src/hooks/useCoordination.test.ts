import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startCoordinationSync,
  type CoordinationConnectionState,
  type CoordinationSnapshot,
} from "./useCoordination";

class FakeOnlineTarget {
  private readonly listeners = new Map<"online" | "offline", Set<() => void>>();

  addEventListener(type: "online" | "offline", listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "online" | "offline", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "online" | "offline"): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

const snapshot: CoordinationSnapshot = {
  driverLease: null,
  presence: {
    sessionId: "sess-1",
    activeUserIds: ["alice@example.com"],
    entries: [{ userId: "alice@example.com", lastSeen: 1, expiresAt: 61 }],
  },
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startCoordinationSync", () => {
  it("reconnects after offline and cleans timers, listeners, and in-flight requests", async () => {
    vi.useFakeTimers();
    const target = new FakeOnlineTarget();
    let online = true;
    const states: CoordinationConnectionState[] = [];
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 2 || signals.length === 4) {
        return new Promise<CoordinationSnapshot>(() => {});
      }
      return Promise.resolve(snapshot);
    });
    const onSnapshot = vi.fn();

    const stop = startCoordinationSync({
      refresh,
      onSnapshot,
      onConnectionState: (state) => states.push(state),
      intervalMs: 1_000,
      eventTarget: target,
      isOnline: () => online,
    });
    await flushPromises();

    expect(states).toEqual(["connecting", "connected"]);
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(target.listenerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("connected");

    online = false;
    target.emit("offline");
    expect(signals[1]?.aborted).toBe(true);
    expect(states.at(-1)).toBe("offline");

    online = true;
    target.emit("online");
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(states.slice(-2)).toEqual(["reconnecting", "connected"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    expect(target.listenerCount()).toBe(0);
    expect(signals[3]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    target.emit("online");
    expect(refresh).toHaveBeenCalledTimes(4);
  });
});

import { authenticatedFetch } from "./identity";
import { fetchSessionItemsPage } from "./sessionsApi";
import type { ConversationItem } from "./conversationItems";

export interface DriverLease {
  sessionId: string;
  holderUserId: string | null;
  generation: number;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
  releasedAt: number | null;
  active: boolean;
}

export interface PresenceEntry {
  userId: string;
  lastSeen: number;
  expiresAt: number;
}

export interface CoordinationPresence {
  sessionId: string;
  activeUserIds: string[];
  entries: PresenceEntry[];
}

export interface CoordinationAuditRecord {
  id: string;
  eventType: string;
  sessionId: string;
  actorUserId: string | null;
  holderUserId: string | null;
  generation: number | null;
  outcome: string | null;
  /** Server Unix timestamp in seconds. */
  createdAt: number | null;
}

export interface CoordinationAuditPage {
  /** Server-authoritative records, newest first. */
  records: CoordinationAuditRecord[];
  /** Cursor for the next bounded scan of older session items. */
  nextCursor: string | null;
}

export interface CoordinationRequestOptions {
  signal?: AbortSignal;
}

export interface ListCoordinationAuditOptions extends CoordinationRequestOptions {
  limit?: number;
  maxPages?: number;
}

export interface AcquireDriverLeaseOptions extends CoordinationRequestOptions {
  ttlSeconds?: number;
  force?: boolean;
}

export interface GenerationLeaseOptions extends CoordinationRequestOptions {
  generation: number;
  ttlSeconds?: number;
}

export interface HandoffDriverLeaseOptions extends GenerationLeaseOptions {
  holderUserId: string;
}

export interface DriverLeaseWire {
  session_id: string;
  holder_user_id: string | null;
  generation: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
  released_at: number | null;
  active: boolean;
}

interface PresenceWire {
  session_id: string;
  active_user_ids: string[];
  entries: Array<{ user_id: string; last_seen: number; expires_at: number }>;
}

interface ErrorWire {
  error?: {
    code?: string;
    message?: string;
    details?: { driver_lease?: DriverLeaseWire | null } & Record<string, unknown>;
  };
}

export class CoordinationApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "CoordinationApiError";
    this.status = status;
    this.code = code;
  }
}

export class DriverLeaseConflictError extends CoordinationApiError {
  readonly currentLease: DriverLease | null;

  constructor(message: string, currentLease: DriverLease | null) {
    super(message, 409, "conflict");
    this.name = "DriverLeaseConflictError";
    this.currentLease = currentLease;
  }
}

export function driverLeaseFromWire(wire: DriverLeaseWire): DriverLease {
  return {
    sessionId: wire.session_id,
    holderUserId: wire.holder_user_id,
    generation: wire.generation,
    acquiredAt: wire.acquired_at,
    renewedAt: wire.renewed_at,
    expiresAt: wire.expires_at,
    releasedAt: wire.released_at,
    active: wire.active,
  };
}

function presenceFromWire(wire: PresenceWire): CoordinationPresence {
  return {
    sessionId: wire.session_id,
    activeUserIds: wire.active_user_ids,
    entries: wire.entries.map((entry) => ({
      userId: entry.user_id,
      lastSeen: entry.last_seen,
      expiresAt: entry.expires_at,
    })),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  let body: ErrorWire | null = null;
  try {
    body = (await response.json()) as ErrorWire;
  } catch {
    // Keep the status-line fallback for empty or non-JSON responses.
  }
  const message = body?.error?.message ?? `${response.status} ${response.statusText}`;
  const code = body?.error?.code ?? null;
  if (response.status === 409 && code === "conflict") {
    const wire = body?.error?.details?.driver_lease;
    throw new DriverLeaseConflictError(message, wire ? driverLeaseFromWire(wire) : null);
  }
  throw new CoordinationApiError(message, response.status, code);
}

function sessionPath(sessionId: string, suffix: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

async function postLease<T>(
  sessionId: string,
  suffix: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await authenticatedFetch(sessionPath(sessionId, suffix), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return readJson<T>(response);
}

export async function getDriverLease(
  sessionId: string,
  options: CoordinationRequestOptions = {},
): Promise<DriverLease | null> {
  const response = await authenticatedFetch(sessionPath(sessionId, "/driver"), {
    signal: options.signal,
  });
  const wire = await readJson<DriverLeaseWire | null>(response);
  return wire === null ? null : driverLeaseFromWire(wire);
}

export async function acquireDriverLease(
  sessionId: string,
  options: AcquireDriverLeaseOptions = {},
): Promise<DriverLease> {
  const wire = await postLease<DriverLeaseWire>(
    sessionId,
    "/driver/acquire",
    {
      ttl_seconds: options.ttlSeconds ?? 30,
      force: options.force ?? false,
    },
    options.signal,
  );
  return driverLeaseFromWire(wire);
}

export async function renewDriverLease(
  sessionId: string,
  options: GenerationLeaseOptions,
): Promise<DriverLease> {
  const wire = await postLease<DriverLeaseWire>(
    sessionId,
    "/driver/renew",
    { generation: options.generation, ttl_seconds: options.ttlSeconds ?? 30 },
    options.signal,
  );
  return driverLeaseFromWire(wire);
}

export async function releaseDriverLease(
  sessionId: string,
  options: GenerationLeaseOptions,
): Promise<DriverLease> {
  const wire = await postLease<DriverLeaseWire>(
    sessionId,
    "/driver/release",
    { generation: options.generation, ttl_seconds: options.ttlSeconds ?? 30 },
    options.signal,
  );
  return driverLeaseFromWire(wire);
}

export async function handoffDriverLease(
  sessionId: string,
  options: HandoffDriverLeaseOptions,
): Promise<DriverLease> {
  const wire = await postLease<DriverLeaseWire>(
    sessionId,
    "/driver/handoff",
    {
      generation: options.generation,
      holder_user_id: options.holderUserId,
      ttl_seconds: options.ttlSeconds ?? 30,
    },
    options.signal,
  );
  return driverLeaseFromWire(wire);
}

export async function heartbeatPresence(
  sessionId: string,
  options: { ttlSeconds?: number; signal?: AbortSignal } = {},
): Promise<CoordinationPresence> {
  const wire = await postLease<PresenceWire>(
    sessionId,
    "/presence/heartbeat",
    { ttl_seconds: options.ttlSeconds ?? 60 },
    options.signal,
  );
  return presenceFromWire(wire);
}

function auditRecordFromItem(item: ConversationItem): CoordinationAuditRecord | null {
  if (item.type !== "resource_event" || item.resource_type !== "driver_lease") return null;
  if (typeof item.event_type !== "string" || !item.event_type.startsWith("session.driver_lease.")) {
    return null;
  }
  const resource =
    item.resource && typeof item.resource === "object" && !Array.isArray(item.resource)
      ? (item.resource as Record<string, unknown>)
      : {};
  const sessionId = resource.session_id;
  if (typeof sessionId !== "string" || !sessionId) return null;
  return {
    id: item.id,
    eventType: item.event_type,
    sessionId,
    actorUserId:
      typeof resource.actor_user_id === "string"
        ? resource.actor_user_id
        : typeof item.created_by === "string"
          ? item.created_by
          : null,
    holderUserId: typeof resource.holder_user_id === "string" ? resource.holder_user_id : null,
    generation:
      typeof item.driver_generation === "number"
        ? item.driver_generation
        : typeof resource.generation === "number"
          ? resource.generation
          : null,
    outcome: typeof item.status === "string" && item.status ? item.status : null,
    createdAt: typeof item.created_at === "number" ? item.created_at : null,
  };
}

const AUDIT_RAW_PAGE_SIZE = 100;
const MAX_AUDIT_SCAN_PAGES = 4;

/**
 * Fetch one bounded page of coordination activity.
 *
 * Coordination events share the session item stream with messages and tool
 * calls, so one activity page may inspect several raw item pages. The scan
 * cap prevents sparse histories from triggering an unbounded crawl while the
 * cursor keeps older history reachable through an explicit user action.
 */
export async function fetchCoordinationAuditPage(
  sessionId: string,
  { cursor, limit = 20, signal }: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<CoordinationAuditPage> {
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 20;
  const recordLimit = Math.max(1, Math.min(100, requestedLimit));
  const records: CoordinationAuditRecord[] = [];
  let scanCursor = cursor;

  for (let pages = 0; pages < MAX_AUDIT_SCAN_PAGES; pages++) {
    // The next raw page depends on the preceding page's oldest inspected item.
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchSessionItemsPage(sessionId, {
      limit: AUDIT_RAW_PAGE_SIZE,
      olderThan: scanCursor,
      signal,
    });
    const newestFirst = [...page.items].reverse();

    for (let index = 0; index < newestFirst.length; index++) {
      const item = newestFirst[index];
      scanCursor = item.id;
      const record = auditRecordFromItem(item);
      if (record) records.push(record);
      if (records.length >= recordLimit) {
        const hasOlderInPage = index < newestFirst.length - 1;
        return {
          records,
          nextCursor: hasOlderInPage || page.hasMore ? scanCursor : null,
        };
      }
    }

    if (!page.hasMore || !scanCursor) return { records, nextCursor: null };
  }

  return { records, nextCursor: scanCursor ?? null };
}

/** Return the newest persisted driver-lease transitions from session history. */
export async function listCoordinationAudit(
  sessionId: string,
  options: ListCoordinationAuditOptions = {},
): Promise<CoordinationAuditRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 1_000));
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 10, 100));
  const records: CoordinationAuditRecord[] = [];
  let olderThan: string | undefined;
  let hasMore = true;
  let pagesScanned = 0;

  while (hasMore && records.length < limit && pagesScanned < maxPages) {
    // Each page cursor comes from the preceding response.
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchSessionItemsPage(sessionId, {
      limit: 1_000,
      olderThan,
      signal: options.signal,
    });
    pagesScanned += 1;
    records.push(
      ...page.items
        .flatMap((item) => {
          const record = auditRecordFromItem(item);
          return record === null ? [] : [record];
        })
        .reverse(),
    );
    hasMore = page.hasMore;
    olderThan = page.items[0]?.id;
    if (!olderThan) break;
  }

  return records.slice(0, limit);
}

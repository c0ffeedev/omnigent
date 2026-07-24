import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export interface ActivityDedupeKey {
  botAppId: string;
  tenantId: string;
  conversationId: string;
  senderId: string;
  activityId: string;
}

export interface RecordedOperation {
  kind: string;
  payload: string;
}

export type ClaimResult =
  | { status: "acquired" | "busy"; operation: RecordedOperation }
  | { status: "delivered"; operation: RecordedOperation; receipt?: string };

interface StoreOptions {
  leaseMilliseconds?: number;
  maxRecords: number;
  retentionDays: number;
}

interface StoredRow extends RecordedOperation {
  attempt_count: number;
  created_at: number;
  delivered_at: number | null;
  lease_expires_at: number;
  lease_owner: string | null;
  receipt: string | null;
  state: "pending" | "delivered";
  updated_at: number;
}

export interface RecordedDelivery extends RecordedOperation {
  attemptCount: number;
  createdAt: number;
  deliveredAt?: number;
  leaseExpiresAt: number;
  receipt?: string;
  state: "pending" | "delivered";
  updatedAt: number;
}

const DEFAULT_LEASE_MILLISECONDS = 30_000;
const RECEIPT_MAX_LENGTH = 512;

export class ActivityDedupeCapacityError extends Error {
  constructor(maxRecords: number) {
    super(`Teams activity operation store reached its ${maxRecords}-record limit`);
    this.name = "ActivityDedupeCapacityError";
  }
}

export class ActivityDedupeStore {
  private readonly database: Database.Database;
  private readonly leaseMilliseconds: number;
  private readonly claimTransaction: (
    key: ActivityDedupeKey,
    operation: RecordedOperation,
    owner: string,
    now: number,
  ) => ClaimResult;

  constructor(path: string, private readonly options: StoreOptions) {
    this.leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    if (!Number.isSafeInteger(this.leaseMilliseconds) || this.leaseMilliseconds < 1) {
      throw new Error("leaseMilliseconds must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new Error("retentionDays must be a positive integer");
    }
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS activity_operations (
        bot_app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
        lease_owner TEXT,
        lease_expires_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        receipt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY (bot_app_id, tenant_id, conversation_id, sender_id, activity_id)
      );
    `);

    this.migrateClaimOnlySchema();
    this.database.exec(`
      DROP INDEX IF EXISTS activity_operations_created_at;
      CREATE INDEX IF NOT EXISTS activity_operations_updated_at
        ON activity_operations(updated_at);
      CREATE INDEX IF NOT EXISTS activity_operations_lease
        ON activity_operations(state, lease_expires_at);
    `);

    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO activity_operations (
        bot_app_id, tenant_id, conversation_id, sender_id, activity_id,
        kind, payload, state, lease_owner, lease_expires_at,
        attempt_count, created_at, updated_at
      ) VALUES (
        @botAppId, @tenantId, @conversationId, @senderId, @activityId,
        @kind, @payload, 'pending', @owner, @leaseExpiresAt,
        1, @createdAt, @createdAt
      )
    `);
    const deleteExpired = this.database.prepare(
      "DELETE FROM activity_operations WHERE updated_at < ?",
    );
    const select = this.database.prepare(`
      SELECT kind, payload, state, lease_owner, lease_expires_at,
        attempt_count, receipt, created_at, updated_at, delivered_at
      FROM activity_operations
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
    `);
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM activity_operations");
    const acquireExpired = this.database.prepare(`
      UPDATE activity_operations
      SET lease_owner = @owner,
        lease_expires_at = @leaseExpiresAt,
        attempt_count = attempt_count + 1,
        updated_at = @now
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
        AND state = 'pending'
        AND lease_expires_at <= @now
    `);

    const claim = this.database.transaction((key, operation, owner, now): ClaimResult => {
      const cutoff = now - this.options.retentionDays * 24 * 60 * 60 * 1000;
      deleteExpired.run(cutoff);
      let row = select.get(key) as StoredRow | undefined;

      if (!row) {
        const currentCount = (count.get() as { count: number }).count;
        if (currentCount >= this.options.maxRecords) {
          throw new ActivityDedupeCapacityError(this.options.maxRecords);
        }
        insert.run({
          ...key,
          ...operation,
          createdAt: now,
          leaseExpiresAt: now + this.leaseMilliseconds,
          owner,
        });
        return { operation, status: "acquired" };
      }

      const recorded = { kind: row.kind, payload: row.payload };
      if (row.state === "delivered") {
        return { operation: recorded, receipt: row.receipt ?? undefined, status: "delivered" };
      }
      if (row.lease_expires_at > now) return { operation: recorded, status: "busy" };

      const acquired = acquireExpired.run({
        ...key,
        leaseExpiresAt: now + this.leaseMilliseconds,
        now,
        owner,
      });
      if (acquired.changes !== 1) return { operation: recorded, status: "busy" };
      row = select.get(key) as StoredRow;
      return { operation: { kind: row.kind, payload: row.payload }, status: "acquired" };
    });
    this.claimTransaction = (key, operation, owner, now) => claim.immediate(key, operation, owner, now);
  }

  private migrateClaimOnlySchema(): void {
    const migrations = new Map([
      ["state", "ALTER TABLE activity_operations ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"],
      ["lease_owner", "ALTER TABLE activity_operations ADD COLUMN lease_owner TEXT"],
      ["lease_expires_at", "ALTER TABLE activity_operations ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0"],
      ["attempt_count", "ALTER TABLE activity_operations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1"],
      ["receipt", "ALTER TABLE activity_operations ADD COLUMN receipt TEXT"],
      ["updated_at", "ALTER TABLE activity_operations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"],
      ["delivered_at", "ALTER TABLE activity_operations ADD COLUMN delivered_at INTEGER"],
    ]);

    const migrate = this.database.transaction(() => {
      const columns = this.database.pragma("table_info(activity_operations)") as Array<{ name: string }>;
      const names = new Set(columns.map(({ name }) => name));
      if ([...migrations.keys()].every((name) => names.has(name))) return;
      for (const [name, sql] of migrations) {
        if (!names.has(name)) this.database.exec(sql);
      }
      this.database.exec(`
        UPDATE activity_operations
        SET updated_at = CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END,
          delivered_at = CASE
            WHEN state = 'delivered' AND delivered_at IS NULL THEN created_at
            ELSE delivered_at
          END;
      `);
    });
    migrate.immediate();
  }

  claim(
    key: ActivityDedupeKey,
    operation: RecordedOperation,
    owner: string,
    now = Date.now(),
  ): ClaimResult {
    if (!owner.trim()) throw new Error("delivery lease owner is required");
    return this.claimTransaction(key, operation, owner, now);
  }

  complete(
    key: ActivityDedupeKey,
    owner: string,
    receipt?: string,
    now = Date.now(),
  ): void {
    const normalizedReceipt = receipt?.trim().slice(0, RECEIPT_MAX_LENGTH) || null;
    const result = this.database.prepare(`
      UPDATE activity_operations
      SET state = 'delivered',
        lease_owner = NULL,
        lease_expires_at = 0,
        receipt = @receipt,
        updated_at = @now,
        delivered_at = @now
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
        AND state = 'pending'
        AND lease_owner = @owner
    `).run({ ...key, now, owner, receipt: normalizedReceipt });
    if (result.changes !== 1) throw new Error("Teams delivery lease is no longer owned by this worker");
  }

  release(key: ActivityDedupeKey, owner: string, now = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE activity_operations
      SET lease_owner = NULL, lease_expires_at = 0, updated_at = @now
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
        AND state = 'pending'
        AND lease_owner = @owner
    `).run({ ...key, now, owner });
    return result.changes === 1;
  }

  get renewalIntervalMilliseconds(): number {
    return Math.max(1, Math.floor(this.leaseMilliseconds / 2));
  }

  renew(key: ActivityDedupeKey, owner: string, now = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE activity_operations
      SET lease_expires_at = @leaseExpiresAt, updated_at = @now
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
        AND state = 'pending'
        AND lease_owner = @owner
    `).run({ ...key, leaseExpiresAt: now + this.leaseMilliseconds, now, owner });
    return result.changes === 1;
  }

  get(key: ActivityDedupeKey): RecordedDelivery | undefined {
    const row = this.database.prepare(`
      SELECT kind, payload, state, lease_owner, lease_expires_at,
        attempt_count, receipt, created_at, updated_at, delivered_at
      FROM activity_operations
      WHERE bot_app_id = @botAppId
        AND tenant_id = @tenantId
        AND conversation_id = @conversationId
        AND sender_id = @senderId
        AND activity_id = @activityId
    `).get(key) as StoredRow | undefined;
    if (!row) return undefined;
    return {
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at ?? undefined,
      kind: row.kind,
      leaseExpiresAt: row.lease_expires_at,
      payload: row.payload,
      receipt: row.receipt ?? undefined,
      state: row.state,
      updatedAt: row.updated_at,
    };
  }

  count(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM activity_operations").get() as { count: number };
    return row.count;
  }

  close(): void {
    this.database.close();
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export interface PrincipalKey {
  botAppId: string;
  tenantId: string;
  objectId: string;
  omnigentOrigin: string;
}

export interface GrantTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  grantId: string;
}

export interface ActiveGrant {
  generation: number;
  grantId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  grantExpiresAt: number;
}

export type GrantStatus =
  | { state: "not_connected" }
  | { state: "connected"; grantId: string; accessExpiresAt: number; grantExpiresAt: number; generation: number }
  | { state: "relink_required"; reason: string };

export type RefreshClaim =
  | { status: "acquired"; grant: ActiveGrant }
  | { status: "busy"; generation: number }
  | { status: "already_refreshed"; grant: ActiveGrant };

interface GrantRow {
  id: number;
  generation: number;
  grant_id: string;
  access_ciphertext: string | null;
  refresh_ciphertext: string | null;
  access_expires_at: number;
  grant_expires_at: number;
  state: "active" | "disabled" | "revocation_pending";
  disable_reason: string | null;
  lease_owner: string | null;
  lease_expires_at: number;
}

interface PreparedGrant {
  access: string;
  accessExpiresAt: number;
  grantExpiresAt: number;
  refresh: string;
}

const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_REFRESH_LEASE_MILLISECONDS = 30_000;
const EXPECTED_DISCONNECT_REASONS = new Set(["logout", "relinked"]);

function aad(key: PrincipalKey, grantId: string): Buffer {
  return Buffer.from(
    `${key.botAppId}\u0000${key.tenantId}\u0000${key.objectId}\u0000${key.omnigentOrigin}\u0000${grantId}`,
  );
}

function encrypt(key: Buffer, plaintext: string, associatedData: Buffer): string {
  if (!plaintext) throw new Error("token must not be empty");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(key: Buffer, envelope: string, associatedData: Buffer): string {
  const value = Buffer.from(envelope, "base64");
  if (value.length < 29) throw new Error("encrypted token envelope is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAAD(associatedData);
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}

function validateTokens(tokens: GrantTokens): void {
  if (
    !tokens.grantId.trim()
    || !tokens.accessToken.trim()
    || !tokens.refreshToken.trim()
    || !Number.isSafeInteger(tokens.expiresIn)
    || tokens.expiresIn < 1
  ) {
    throw new Error("grant token response is invalid");
  }
}

export class GrantStore {
  private readonly database: Database.Database;
  private readonly refreshLeaseMilliseconds: number;
  private readonly maximumLifetimeMilliseconds: number;

  constructor(
    path: string,
    private readonly encryptionKey: Buffer,
    options: { maximumLifetimeDays: number; refreshLeaseMilliseconds?: number },
  ) {
    if (encryptionKey.length !== 32) throw new Error("grant encryption key must be 32 bytes");
    if (options.maximumLifetimeDays !== 30) {
      throw new Error("maximumLifetimeDays must match the Omnigent server lifetime of 30 days");
    }
    this.maximumLifetimeMilliseconds = options.maximumLifetimeDays * 24 * 60 * 60 * 1000;
    this.refreshLeaseMilliseconds = options.refreshLeaseMilliseconds ?? DEFAULT_REFRESH_LEASE_MILLISECONDS;
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS principal_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        omnigent_origin TEXT NOT NULL,
        generation INTEGER NOT NULL,
        grant_id TEXT NOT NULL,
        access_ciphertext TEXT,
        refresh_ciphertext TEXT,
        access_expires_at INTEGER NOT NULL,
        grant_expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'revocation_pending')),
        disable_reason TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        revocation_attempts INTEGER NOT NULL DEFAULT 0,
        next_revocation_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS principal_grants_one_active
        ON principal_grants(bot_app_id, tenant_id, object_id, omnigent_origin) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS principal_grants_revocation
        ON principal_grants(state, next_revocation_at);
      CREATE TABLE IF NOT EXISTS principal_connect_attempts (
        bot_app_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        omnigent_origin TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'cancelled', 'completed')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_app_id, tenant_id, object_id, omnigent_origin)
      );
    `);
  }

  private activeRow(key: PrincipalKey): GrantRow | undefined {
    return this.database.prepare(`
      SELECT id, generation, grant_id, access_ciphertext, refresh_ciphertext,
        access_expires_at, grant_expires_at, state, disable_reason, lease_owner, lease_expires_at
      FROM principal_grants
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
        AND state = 'active'
    `).get(key) as GrantRow | undefined;
  }

  private toGrant(key: PrincipalKey, row: GrantRow): ActiveGrant {
    if (!row.access_ciphertext || !row.refresh_ciphertext) throw new Error("active grant is missing token material");
    const associatedData = aad(key, row.grant_id);
    return {
      accessExpiresAt: row.access_expires_at,
      accessToken: decrypt(this.encryptionKey, row.access_ciphertext, associatedData),
      generation: row.generation,
      grantExpiresAt: row.grant_expires_at,
      grantId: row.grant_id,
      refreshToken: decrypt(this.encryptionKey, row.refresh_ciphertext, associatedData),
    };
  }

  private prepareGrant(key: PrincipalKey, tokens: GrantTokens, now: number): PreparedGrant {
    validateTokens(tokens);
    const associatedData = aad(key, tokens.grantId);
    return {
      access: encrypt(this.encryptionKey, tokens.accessToken, associatedData),
      accessExpiresAt: now + tokens.expiresIn * 1000,
      grantExpiresAt: now + this.maximumLifetimeMilliseconds,
      refresh: encrypt(this.encryptionKey, tokens.refreshToken, associatedData),
    };
  }

  private insertActiveGrant(
    key: PrincipalKey,
    tokens: GrantTokens,
    prepared: PreparedGrant,
    now: number,
  ): GrantRow {
    const previous = this.activeRow(key);
    if (previous) {
      this.database.prepare(`
        UPDATE principal_grants
        SET state = 'revocation_pending', disable_reason = 'relinked', lease_owner = NULL,
          lease_expires_at = 0, updated_at = @now
        WHERE id = @id AND state = 'active'
      `).run({ id: previous.id, now });
    }
    const last = this.database.prepare(`
      SELECT MAX(generation) AS generation FROM principal_grants
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
    `).get(key) as { generation: number | null };
    const generation = (last.generation ?? 0) + 1;
    this.database.prepare(`
      INSERT INTO principal_grants (
        bot_app_id, tenant_id, object_id, omnigent_origin, generation, grant_id,
        access_ciphertext, refresh_ciphertext, access_expires_at, grant_expires_at,
        state, created_at, updated_at
      ) VALUES (
        @botAppId, @tenantId, @objectId, @omnigentOrigin, @generation, @grantId,
        @access, @refresh, @accessExpiresAt, @grantExpiresAt, 'active', @now, @now
      )
    `).run({ ...key, ...prepared, generation, grantId: tokens.grantId, now });
    return this.activeRow(key)!;
  }

  private insertRevocationTombstone(
    key: PrincipalKey,
    tokens: GrantTokens,
    prepared: PreparedGrant,
    reason: string,
    now: number,
  ): void {
    const last = this.database.prepare(`
      SELECT MAX(generation) AS generation FROM principal_grants
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
    `).get(key) as { generation: number | null };
    this.database.prepare(`
      INSERT INTO principal_grants (
        bot_app_id, tenant_id, object_id, omnigent_origin, generation, grant_id,
        access_ciphertext, refresh_ciphertext, access_expires_at, grant_expires_at,
        state, disable_reason, created_at, updated_at
      ) VALUES (
        @botAppId, @tenantId, @objectId, @omnigentOrigin, @generation, @grantId,
        @access, @refresh, @accessExpiresAt, @grantExpiresAt,
        'revocation_pending', @reason, @now, @now
      )
    `).run({
      ...key,
      ...prepared,
      generation: (last.generation ?? 0) + 1,
      grantId: tokens.grantId,
      now,
      reason,
    });
  }

  beginConnect(key: PrincipalKey, now = Date.now()): number {
    return this.database.transaction(() => {
      this.queueRevocation(key, "relinked", now);
      const current = this.database.prepare(`
        SELECT generation FROM principal_connect_attempts
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin
      `).get(key) as { generation: number } | undefined;
      const generation = (current?.generation ?? 0) + 1;
      this.database.prepare(`
        INSERT INTO principal_connect_attempts (
          bot_app_id, tenant_id, object_id, omnigent_origin, generation, state, updated_at
        ) VALUES (
          @botAppId, @tenantId, @objectId, @omnigentOrigin, @generation, 'pending', @now
        )
        ON CONFLICT (bot_app_id, tenant_id, object_id, omnigent_origin) DO UPDATE SET
          generation = excluded.generation, state = 'pending', updated_at = excluded.updated_at
      `).run({ ...key, generation, now });
      return generation;
    }).immediate();
  }

  cancelConnect(key: PrincipalKey, generation: number, now = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE principal_connect_attempts SET state = 'cancelled', updated_at = @now
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin AND generation = @generation AND state = 'pending'
    `).run({ ...key, generation, now });
    return result.changes === 1;
  }

  completeConnect(
    key: PrincipalKey,
    connectGeneration: number,
    tokens: GrantTokens,
    now = Date.now(),
  ): ActiveGrant | undefined {
    const prepared = this.prepareGrant(key, tokens, now);
    const row = this.database.transaction(() => {
      const claimed = this.database.prepare(`
        UPDATE principal_connect_attempts SET state = 'completed', updated_at = @now
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin
          AND generation = @connectGeneration AND state = 'pending'
      `).run({ ...key, connectGeneration, now });
      if (claimed.changes !== 1) {
        this.insertRevocationTombstone(key, tokens, prepared, "stale_connect_completion", now);
        return undefined;
      }
      return this.insertActiveGrant(key, tokens, prepared, now);
    }).immediate();
    return row ? this.toGrant(key, row) : undefined;
  }

  link(key: PrincipalKey, tokens: GrantTokens, now = Date.now()): ActiveGrant {
    const prepared = this.prepareGrant(key, tokens, now);
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE principal_connect_attempts SET state = 'cancelled', updated_at = @now
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin AND state = 'pending'
      `).run({ ...key, now });
      return this.insertActiveGrant(key, tokens, prepared, now);
    });
    return this.toGrant(key, transaction.immediate());
  }

  status(key: PrincipalKey, now = Date.now()): GrantStatus {
    return this.database.transaction(() => {
      const active = this.activeRow(key);
      if (active) {
        if (active.grant_expires_at <= now) {
          this.database.prepare(`
            UPDATE principal_grants
            SET state = 'revocation_pending', disable_reason = 'maximum_lifetime_exceeded',
              lease_owner = NULL, lease_expires_at = 0, updated_at = @now
            WHERE id = @id AND generation = @generation AND state = 'active'
          `).run({ generation: active.generation, id: active.id, now });
          return { reason: "maximum_lifetime_exceeded", state: "relink_required" };
        }
        return {
          accessExpiresAt: active.access_expires_at,
          generation: active.generation,
          grantExpiresAt: active.grant_expires_at,
          grantId: active.grant_id,
          state: "connected",
        };
      }
      const disabled = this.database.prepare(`
        SELECT disable_reason FROM principal_grants
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin
          AND state IN ('disabled', 'revocation_pending')
        ORDER BY generation DESC LIMIT 1
      `).get(key) as { disable_reason: string | null } | undefined;
      if (disabled?.disable_reason && EXPECTED_DISCONNECT_REASONS.has(disabled.disable_reason)) {
        return { state: "not_connected" };
      }
      return disabled
        ? { reason: disabled.disable_reason ?? "grant_disabled", state: "relink_required" }
        : { state: "not_connected" };
    }).immediate() as GrantStatus;
  }

  active(key: PrincipalKey, now = Date.now()): ActiveGrant | undefined {
    if (this.status(key, now).state !== "connected") return undefined;
    const row = this.activeRow(key);
    return row ? this.toGrant(key, row) : undefined;
  }

  acquireRefresh(key: PrincipalKey, owner: string, expectedGeneration: number, now = Date.now()): RefreshClaim {
    if (!owner.trim()) throw new Error("refresh lease owner is required");
    const transaction = this.database.transaction((): RefreshClaim | "lifetime" | "uncertain" => {
      const row = this.activeRow(key);
      if (!row) throw new Error("grant is not connected");
      if (row.grant_expires_at <= now) {
        this.queueRevocation(key, "maximum_lifetime_exceeded", now);
        return "lifetime";
      }
      if (row.generation !== expectedGeneration) return { grant: this.toGrant(key, row), status: "already_refreshed" };
      if (row.lease_owner && row.lease_expires_at <= now) {
        this.queueRevocation(key, "refresh_outcome_uncertain", now);
        return "uncertain";
      }
      if (row.lease_owner) return { generation: row.generation, status: "busy" };
      const updated = this.database.prepare(`
        UPDATE principal_grants SET lease_owner = @owner, lease_expires_at = @leaseExpiresAt,
          updated_at = @now
        WHERE id = @id AND state = 'active' AND lease_owner IS NULL AND generation = @generation
      `).run({ generation: row.generation, id: row.id, leaseExpiresAt: now + this.refreshLeaseMilliseconds, now, owner });
      if (updated.changes !== 1) return { generation: row.generation, status: "busy" };
      return { grant: this.toGrant(key, this.activeRow(key)!), status: "acquired" };
    });
    const result = transaction.immediate();
    if (result === "lifetime") throw new Error("grant requires relinking");
    if (result === "uncertain") throw new Error("refresh outcome is uncertain; relink required");
    return result;
  }

  commitRefresh(
    key: PrincipalKey,
    owner: string,
    expectedGeneration: number,
    tokens: GrantTokens,
    now = Date.now(),
  ): ActiveGrant {
    validateTokens(tokens);
    const associatedData = aad(key, tokens.grantId);
    const access = encrypt(this.encryptionKey, tokens.accessToken, associatedData);
    const refresh = encrypt(this.encryptionKey, tokens.refreshToken, associatedData);
    const transaction = this.database.transaction((): GrantRow | undefined => {
      const result = this.database.prepare(`
        UPDATE principal_grants
        SET generation = generation + 1, grant_id = @grantId,
          access_ciphertext = @access, refresh_ciphertext = @refresh,
          access_expires_at = @accessExpiresAt, lease_owner = NULL, lease_expires_at = 0,
          updated_at = @now
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin
          AND state = 'active' AND generation = @expectedGeneration AND lease_owner = @owner
      `).run({
        ...key,
        access,
        accessExpiresAt: now + tokens.expiresIn * 1000,
        expectedGeneration,
        grantId: tokens.grantId,
        now,
        owner,
        refresh,
      });
      if (result.changes !== 1) return undefined;
      return this.activeRow(key)!;
    });
    const row = transaction.immediate();
    if (!row) {
      this.database.transaction(() => {
        this.database.prepare(`
          UPDATE principal_grants
          SET state = 'revocation_pending', disable_reason = 'refresh_cas_lost',
            lease_owner = NULL, lease_expires_at = 0, updated_at = @now
          WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
            AND omnigent_origin = @omnigentOrigin
            AND state = 'active' AND generation = @expectedGeneration
        `).run({ ...key, expectedGeneration, now });
        const source = this.database.prepare(`
          SELECT grant_expires_at FROM principal_grants
          WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
            AND omnigent_origin = @omnigentOrigin AND generation = @expectedGeneration
          ORDER BY id DESC LIMIT 1
        `).get({ ...key, expectedGeneration }) as { grant_expires_at: number } | undefined;
        this.database.prepare(`
          INSERT INTO principal_grants (
            bot_app_id, tenant_id, object_id, omnigent_origin, generation, grant_id,
            access_ciphertext, refresh_ciphertext, access_expires_at, grant_expires_at,
            state, disable_reason, created_at, updated_at
          ) VALUES (
            @botAppId, @tenantId, @objectId, @omnigentOrigin, @generation, @grantId,
            @access, @refresh, @accessExpiresAt, @grantExpiresAt,
            'revocation_pending', 'refresh_cas_lost', @now, @now
          )
        `).run({
          ...key,
          access,
          accessExpiresAt: now + tokens.expiresIn * 1000,
          generation: expectedGeneration + 1,
          grantExpiresAt: source?.grant_expires_at ?? now + this.maximumLifetimeMilliseconds,
          grantId: tokens.grantId,
          now,
          refresh,
        });
      }).immediate();
      throw new Error("refresh result lost its generation fence; relink required");
    }
    return this.toGrant(key, row);
  }

  markRefreshUncertain(key: PrincipalKey, owner: string, expectedGeneration: number, now = Date.now()): void {
    this.database.prepare(`
      UPDATE principal_grants
      SET state = 'revocation_pending', disable_reason = 'refresh_outcome_uncertain',
        lease_owner = NULL, lease_expires_at = 0, updated_at = @now
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
        AND state = 'active' AND generation = @expectedGeneration AND lease_owner = @owner
    `).run({ ...key, expectedGeneration, now, owner });
  }

  rejectRefresh(key: PrincipalKey, owner: string, expectedGeneration: number, now = Date.now()): void {
    this.database.prepare(`
      UPDATE principal_grants
      SET state = 'disabled', disable_reason = 'refresh_rejected',
        access_ciphertext = NULL, refresh_ciphertext = NULL,
        lease_owner = NULL, lease_expires_at = 0, updated_at = @now
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
        AND state = 'active' AND generation = @expectedGeneration AND lease_owner = @owner
    `).run({ ...key, expectedGeneration, now, owner });
  }

  logout(key: PrincipalKey, now = Date.now()): boolean {
    return this.database.transaction(() => {
      const cancelled = this.database.prepare(`
        UPDATE principal_connect_attempts SET state = 'cancelled', updated_at = @now
        WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
          AND omnigent_origin = @omnigentOrigin AND state = 'pending'
      `).run({ ...key, now });
      return this.queueRevocation(key, "logout", now) || cancelled.changes === 1;
    }).immediate();
  }

  private queueRevocation(key: PrincipalKey, reason: string, now: number): boolean {
    const result = this.database.prepare(`
      UPDATE principal_grants SET state = 'revocation_pending', disable_reason = @reason,
        lease_owner = NULL, lease_expires_at = 0, updated_at = @now
      WHERE bot_app_id = @botAppId AND tenant_id = @tenantId AND object_id = @objectId
        AND omnigent_origin = @omnigentOrigin
        AND state = 'active'
    `).run({ ...key, now, reason });
    return result.changes === 1;
  }


  pendingRevocations(now = Date.now(), limit = 100): Array<{ id: number; key: PrincipalKey; refreshToken: string }> {
    const rows = this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM principal_grants
        WHERE state = 'revocation_pending' AND grant_expires_at <= @now
      `).run({ now });
      return this.database.prepare(`
        SELECT id, bot_app_id, tenant_id, object_id, omnigent_origin, grant_id, refresh_ciphertext
        FROM principal_grants
        WHERE state = 'revocation_pending' AND next_revocation_at <= @now
        ORDER BY updated_at LIMIT @limit
      `).all({ limit, now }) as Array<{
        id: number; bot_app_id: string; tenant_id: string; object_id: string;
        omnigent_origin: string; grant_id: string; refresh_ciphertext: string | null;
      }>;
    }).immediate();
    return rows.flatMap((row) => {
      if (!row.refresh_ciphertext) return [];
      const key = {
        botAppId: row.bot_app_id,
        objectId: row.object_id,
        omnigentOrigin: row.omnigent_origin,
        tenantId: row.tenant_id,
      };
      return [{ id: row.id, key, refreshToken: decrypt(this.encryptionKey, row.refresh_ciphertext, aad(key, row.grant_id)) }];
    });
  }

  completeRevocation(id: number): void {
    this.database.prepare("DELETE FROM principal_grants WHERE id = ? AND state = 'revocation_pending'").run(id);
  }

  deferRevocation(id: number, now = Date.now()): void {
    this.database.prepare(`
      UPDATE principal_grants
      SET revocation_attempts = revocation_attempts + 1,
        next_revocation_at = @now + MIN(
          3600000,
          60000 * (1 << MIN(revocation_attempts, 6))
        ),
        updated_at = @now
      WHERE id = @id AND state = 'revocation_pending'
    `).run({ id, now });
  }

  close(): void {
    this.database.close();
  }
}

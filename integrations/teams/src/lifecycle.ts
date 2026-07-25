import { randomUUID } from "node:crypto";

import type { EntraPrincipal } from "./identity.js";
import { GrantStore, type ActiveGrant, type PrincipalKey } from "./grants.js";
import { OmnigentDeviceClient, OmnigentOAuthError } from "./omnigent.js";

const REFRESH_WAIT_ATTEMPTS = 320;
const REFRESH_WAIT_MILLISECONDS = 100;

export interface ConnectResult {
  message: string;
  completion: Promise<string>;
}

export class GrantLifecycle {
  constructor(
    private readonly botAppId: string,
    private readonly omnigentOrigin: string,
    private readonly store: GrantStore,
    private readonly client: OmnigentDeviceClient,
  ) {}

  key(principal: EntraPrincipal): PrincipalKey {
    return {
      botAppId: this.botAppId,
      objectId: principal.objectId,
      omnigentOrigin: this.omnigentOrigin,
      tenantId: principal.tenantId,
    };
  }

  async connect(principal: EntraPrincipal): Promise<ConnectResult> {
    const key = this.key(principal);
    const pending = await this.client.startLogin();
    const code = pending.userCode ? ` and enter code ${pending.userCode}` : "";
    return {
      completion: pending.poll().then((tokens) => {
        this.store.link(key, tokens);
        return "Omnigent account connected. You can now use `status` or `logout`.";
      }).catch(() => {
        return "Omnigent account connection failed. Send `connect` to retry.";
      }),
      message: `Open ${pending.verificationUrl}${code} to connect your Omnigent account. This link expires soon.`,
    };
  }

  status(principal: EntraPrincipal, now = Date.now()): string {
    const status = this.store.status(this.key(principal), now);
    if (status.state === "not_connected") return "No Omnigent account is connected. Send `connect` to begin.";
    if (status.state === "relink_required") {
      return "The Omnigent grant is disabled and requires relinking. Send `connect` to continue.";
    }
    return `Omnigent account connected. Access token expires ${new Date(status.accessExpiresAt).toISOString()}; grant lifetime ends ${new Date(status.grantExpiresAt).toISOString()}.`;
  }

  logout(principal: EntraPrincipal): string {
    const changed = this.store.logout(this.key(principal));
    return changed
      ? "Omnigent account disconnected locally. Remote revocation is queued."
      : "No active Omnigent account connection was found.";
  }

  uninstall(principal: EntraPrincipal): void {
    this.store.logout(this.key(principal));
  }

  async refreshAfterUnauthorized(
    principal: EntraPrincipal,
    expectedGeneration: number,
  ): Promise<ActiveGrant> {
    const key = this.key(principal);
    for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt += 1) {
      const owner = randomUUID();
      const claim = this.store.acquireRefresh(key, owner, expectedGeneration);
      if (claim.status === "already_refreshed") return claim.grant;
      if (claim.status === "busy") {
        await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MILLISECONDS));
        continue;
      }
      try {
        const tokens = await this.client.refresh(claim.grant.refreshToken);
        return this.store.commitRefresh(key, owner, expectedGeneration, tokens);
      } catch (error) {
        const uncertain = !(error instanceof OmnigentOAuthError) || error.outcomeMayBeUncertain;
        if (uncertain) this.store.markRefreshUncertain(key, owner, expectedGeneration);
        else this.store.rejectRefresh(key, owner, expectedGeneration);
        throw error;
      }
    }
    throw new Error("Omnigent token refresh did not complete");
  }

  async reconcileRevocations(): Promise<{ completed: number; deferred: number }> {
    let completed = 0;
    let deferred = 0;
    for (const pending of this.store.pendingRevocations()) {
      try {
        if (await this.client.revoke(pending.refreshToken)) {
          this.store.completeRevocation(pending.id);
          completed += 1;
        } else {
          this.store.deferRevocation(pending.id);
          deferred += 1;
        }
      } catch {
        this.store.deferRevocation(pending.id);
        deferred += 1;
      }
    }
    return { completed, deferred };
  }
}

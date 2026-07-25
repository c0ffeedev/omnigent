# Teams delegated-grant smoke test

Run only in an approved staging tenant and Omnigent staging deployment. Never use personal or production credentials.

## Accounts and evidence

Use distinct identities so accidental identity conflation is visible:

- Teams user A in allowlisted resource tenant A.
- Teams user B in allowlisted resource tenant B, or a second user in tenant A when only one resource tenant is approved.
- Omnigent user A and Omnigent user B, each approved for staging and unrelated to the corresponding Teams identities.

Record only timestamps, tenant aliases, expected outcomes, and redacted grant IDs. Do not capture SSO, access, refresh, device, or client-secret values.

## Setup

1. Copy `.env.example` to `.env`, fill it from staging secret management, and set both tenant IDs in `TEAMS_ALLOWED_TENANT_IDS` when cross-tenant testing is approved.
2. Start the integration:

       set -a
       . ./.env
       set +a
       npm ci
       npm run dev

3. Expose port 3978 through an approved HTTPS tunnel and configure the Azure Bot endpoint as `https://<tunnel-host>/api/messages`.
4. Substitute `TEAMS_APP_ID`, `BOT_APP_ID`, and `BOT_DOMAIN` in `appPackage/manifest.json` (or use Agents Toolkit), package the manifest and icons at the archive root, and install it in each approved tenant.
5. Confirm the app cannot be added to a team, group chat, or meeting and that the app registration requests no Microsoft Graph permissions.

## Principal A lifecycle

1. As Teams user A, open a personal chat and send `status`. Complete Teams SSO if prompted. Expect `No Omnigent account is connected.`
2. Send `connect`. Expect a verification URL and user code for the configured Omnigent origin only.
3. Open that URL in a private browser, sign in as Omnigent user A, verify the displayed code, and approve the narrow interactive grant.
4. Expect a follow-up `Omnigent account connected.` message. Send `status`; expect `Omnigent is connected.` and a maximum-lifetime timestamp.
5. Restart the Teams integration process without changing the grant database or encryption key. Send `status` again; expect it to remain connected.
6. Send `connect` again and approve as Omnigent user B. Expect the active binding to move to the new grant; confirm server-side that the old grant is revoked or queued for retry and is not usable by the integration.
7. Send `logout`. Expect immediate `Omnigent account disconnected locally.` and then `No Omnigent account is connected.` from `status`. Confirm remote revocation succeeds or remains in the encrypted retry queue.

## Isolation

1. Reconnect Teams user A to Omnigent user A.
2. As Teams user B in a separate personal chat, send `status`; expect `No Omnigent account is connected.`
3. Connect Teams user B to Omnigent user B. Confirm both users see only their own status.
4. If an approved disallowed-tenant test account is available, attempt to message the bot from that tenant. Expect denial before SSO or Omnigent device authorization begins.
5. Replay or alter a captured activity only through the automated tests; do not send fabricated traffic to shared staging. `npm test` covers tenant/object mismatch, wrong audience/issuer/signature, duplicate activity delivery, and refresh fencing.

## Removal cleanup

1. Ensure Teams user A is connected, then remove/uninstall the personal app.
2. Confirm the local grant loses runtime authority immediately and remote revocation succeeds or is durably queued.
3. Reinstall the app and send `status`; expect `No Omnigent account is connected.` until a new `connect` flow completes.

## Automated closure

Run from `integrations/teams`:

    npm test
    npm run typecheck
    npm run lint
    npm run build

Delete the staging app installation, tunnel, local SQLite files, and temporary `.env` after collecting redacted evidence. Rotate any staging secret exposed outside the approved secret manager.

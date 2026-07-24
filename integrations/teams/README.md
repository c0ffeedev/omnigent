# Omnigent Microsoft Teams integration

This independent TypeScript package implements ADR slice 2: authenticated Microsoft Teams ingress, personal-scope policy, durable activity deduplication, and a static `help` response. It does not link Omnigent accounts, create sessions, invoke models, read Microsoft Graph, or import the Slack integration.

## Security boundary

- Microsoft Teams SDK validates Bot Framework service JWT signature, issuer, audience/app ID, expiry, and the exact activity service URL before dispatch. The activity must supply a canonical HTTPS service URL so omission cannot disable the SDK's claim-to-body comparison; forwarded authorization headers are not trusted.
- The package then requires the canonical `28:<bot-app-id>` recipient, matching UUID tenant IDs in both `conversation.tenantId` and `channelData.tenant.id`, a UUID `from.aadObjectId`, an opaque Teams sender ID, and a personal conversation. Opaque IDs must be bounded printable ASCII without surrounding whitespace; UUID comparisons are case-normalized.
- Team and group-chat scopes, either missing tenant field, mismatched tenant identity, malformed identity fields, alternate recipient forms, and non-Teams activities fail closed.
- The manifest declares only personal bot scope and no Graph permissions.
- Bot credentials come from deployment secret management and are never stored in SQLite. A redacting logger drops structured SDK arguments (including activity bodies and exception objects) and removes bearer/JWT/known-secret material from string messages before forwarding logs.

The SQLite dedupe key is `(bot_app_id, tenant_id, conversation_id, sender_id, activity_id)`, where `sender_id` is the normalized Entra sender object ID rather than a display name or mutable message field. Claiming a key atomically stores one pending Teams reply operation and a renewable delivery lease. A successful send records the channel receipt and marks the operation delivered; a failed send releases the lease, and a crashed worker's lease can be reclaimed after expiry. Duplicate requests receive a retryable server error while a lease is active and are acknowledged without another send after delivery. WAL plus an immediate transaction and unique primary key serialize competing local worker processes. Every record carries an indexed expiry timestamp; claims prune expired records transactionally, and operators may call `cleanupExpired()` from a maintenance loop during idle periods. A full unexpired store rejects new work instead of evicting dedupe evidence. Databases created by the initial channel-sender-key implementation remain fail-closed: existing rows are detected and completed under their legacy key, while new rows use the Entra principal key.

A hard crash or transport error after Teams accepts a reply but before its receipt is persisted is an inherently ambiguous remote outcome; recovery may resend that static reply, but it never creates a second recorded operation. Legacy claim-only rows are also migrated as pending because they contain no proof that Teams accepted the reply; retrying the bounded static response is safer than permanently suppressing it. A single SQLite file is suitable for multiple processes on one host; a multi-host deployment must replace it with a shared transactional database while preserving the same state, lease, and fencing contract.

## Configure

Requires Node.js 20 or later.

1. Register a single-tenant Entra application and Azure Bot using the same bot app ID. Create a client secret in deployment secret management.
2. Enable the Microsoft Teams channel on the Azure Bot.
3. Configure its messaging endpoint as `https://<BOT_DOMAIN>/api/messages`.
4. Copy `.env.example` to a local `.env`, insert test credentials, set the app-registration tenant, and explicitly list every accepted Teams resource tenant.
5. Install and verify:

       npm ci
       npm test
       npm run typecheck
       npm run build

Production should inject environment variables directly rather than using `.env`.
Configuration parsing and dedupe database initialization occur before `app.start`, so invalid or ambiguous security configuration and unusable durable storage fail before the SDK binds a listening socket.

## Run a local smoke test

1. Export the `.env` values and start the service:

       set -a
       . ./.env
       set +a
       npm run dev

2. Expose port 3978 through an HTTPS development tunnel and set the Azure Bot messaging endpoint to `https://<tunnel-host>/api/messages`.
3. In `appPackage/manifest.json`, replace `TEAMS_APP_ID` with the Teams app package ID, `BOT_APP_ID` with the Azure Bot app ID, and `BOT_DOMAIN` with the tunnel hostname. Keep the `${{...}}` placeholders when using Microsoft 365 Agents Toolkit environment substitution.
4. Zip `manifest.json`, `color.png`, and `outline.png` at the archive root, then upload the custom app to the allowlisted test tenant.
5. Open the bot in a personal chat and send `help`. Confirm the static help response appears once.
6. Send `new`. Confirm the bot says that only `help` is available and no Omnigent session is created.
7. Retry the same captured activity through the deterministic test suite (`npm test`) to verify one recorded operation across duplicate requests, operating-system processes, send failure, and process restart.
8. Attempt to add the bot to a group chat or team. The personal-only manifest should not offer those scopes; direct non-personal activities are also rejected by runtime policy.

## Staging verification

Use a dedicated app registration and allowlisted test tenant. Verify personal `help`, disallowed-tenant denial, restart persistence, and that Azure/Teams diagnostics show no requested Microsoft Graph permissions. Rotate/delete the staging client secret and remove the tunnel after testing.

## Manifest packaging

The template is `appPackage/manifest.json`; required 192x192 color and 32x32 transparent-outline icons are included. The template intentionally has no `authorization` section, resource-specific permissions, team scope, group-chat scope, wildcard valid domain, or Graph capability.

## Operations

- Health/public diagnostic endpoints, public deployment, production hardening, account linking, sessions, Graph reads, and proactive delivery are intentionally outside this slice.
- SQLite state contains only opaque activity routing IDs and bounded static response metadata; it contains no message body, token, secret, or Omnigent content.
- Stop with `SIGINT` or `SIGTERM` so the SDK server and database close cleanly.

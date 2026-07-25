# Omnigent Microsoft Teams integration

This independent TypeScript package implements ADR slices 2 and 3: authenticated personal-scope Teams ingress, Entra SSO principal binding, RFC 8628 Omnigent account linking, encrypted delegated-grant storage, and deterministic grant cleanup. It does not create sessions, invoke models, read Microsoft Graph, or import the Slack integration.

## Security boundary

- Microsoft Teams SDK validates Bot Framework service JWT signature, issuer, audience/app ID, expiry, and the exact activity service URL before dispatch. The activity must supply a canonical HTTPS service URL so omission cannot disable the SDK's claim-to-body comparison; forwarded authorization headers are not trusted.
- The package then requires the canonical `28:<bot-app-id>` recipient, matching UUID tenant IDs in both `conversation.tenantId` and `channelData.tenant.id`, a UUID `from.aadObjectId`, an opaque Teams sender ID, and a personal conversation. Opaque IDs must be bounded printable ASCII without surrounding whitespace; UUID comparisons are case-normalized.
- Team and group-chat scopes, either missing tenant field, mismatched tenant identity, malformed identity fields, alternate recipient forms, and non-Teams activities fail closed.
- The manifest declares only personal bot scope and no Graph permissions.
- Bot credentials come from deployment secret management and are never stored in SQLite. A redacting logger drops structured SDK arguments (including activity bodies and exception objects) and removes bearer/JWT/known-secret material from string messages before forwarding logs.
- `connect`, `status`, and `logout` require a cryptographically validated Entra SSO token whose tenant and object ID exactly match the signed Teams activity. Display names, email addresses, UPNs, and mutable Teams sender IDs never establish grant authority.
- Omnigent device authorization is pinned to one configured HTTPS origin and requests only the `interactive` scope. Delegated tokens are AES-256-GCM encrypted at rest with principal-and-grant associated data; plaintext tokens are never logged or returned to Teams.

The SQLite dedupe key is `(bot_app_id, tenant_id, conversation_id, sender_id, activity_id)`, where `sender_id` is the normalized Entra sender object ID rather than a display name or mutable message field. Claiming a key atomically stores one pending Teams reply operation and a renewable delivery lease. A successful send records the channel receipt and marks the operation delivered; a failed send releases the lease, and a crashed worker's lease can be reclaimed after expiry. Duplicate requests receive a retryable server error while a lease is active and are acknowledged without another send after delivery. WAL plus an immediate transaction and unique primary key serialize competing local worker processes. Every record carries an indexed expiry timestamp; claims prune expired records transactionally, and operators may call `cleanupExpired()` from a maintenance loop during idle periods. A full unexpired store rejects new work instead of evicting dedupe evidence. Databases created by the initial channel-sender-key implementation remain fail-closed: existing rows are detected and completed under their legacy key, while new rows use the Entra principal key.

A hard crash or transport error after Teams accepts a reply but before its receipt is persisted is an inherently ambiguous remote outcome; recovery may resend that static reply, but it never creates a second recorded operation. Legacy claim-only rows are also migrated as pending because they contain no proof that Teams accepted the reply; retrying the bounded static response is safer than permanently suppressing it. A single SQLite file is suitable for multiple processes on one host; a multi-host deployment must replace it with a shared transactional database while preserving the same state, lease, and fencing contract.

## Configure

Requires Node.js 20 or later.

1. Register a single-tenant Entra application and Azure Bot using the same bot app ID. Create a client secret in deployment secret management.
2. Enable the Microsoft Teams channel on the Azure Bot.
3. Configure its messaging endpoint as `https://<BOT_DOMAIN>/api/messages`.
4. Expose an API URI for Teams SSO and configure the Azure Bot OAuth connection named by `TEAMS_SSO_CONNECTION_NAME`. It must issue v2 Entra tokens for the exact `TEAMS_SSO_AUDIENCE`.
5. Register an Omnigent RFC 8628 client with only the `interactive` scope. Set `OMNIGENT_ORIGIN` to its fixed HTTPS deployment origin.
6. Copy `.env.example` to a local `.env`, insert test credentials, set the app-registration tenant, explicitly list every accepted Teams resource tenant, and generate an independent 32-byte grant encryption key.
7. Install and verify:

       npm ci
       npm test
       npm run typecheck
       npm run build

Production should inject environment variables directly rather than using `.env`.
Configuration parsing and dedupe database initialization occur before `app.start`, so invalid or ambiguous security configuration and unusable durable storage fail before the SDK binds a listening socket.

## Run a smoke test

Use the operator checklist in `SMOKE_TEST.md`. It requires separate approved Teams and Omnigent test accounts and covers `connect`, `status`, `logout`, reinstall cleanup, cross-tenant isolation, restart persistence, and scope denial.

## Staging verification

Use a dedicated app registration and allowlisted test tenant. Verify the complete `SMOKE_TEST.md` matrix and that Azure/Teams diagnostics show no requested Microsoft Graph permissions. Rotate/delete staging secrets and remove the tunnel after testing.

## Manifest packaging

The template is `appPackage/manifest.json`; required 192x192 color and 32x32 transparent-outline icons are included. The template intentionally has no `authorization` section, resource-specific permissions, team scope, group-chat scope, wildcard valid domain, or Graph capability.

## Operations

- Health/public diagnostic endpoints, public deployment, sessions, Graph reads, and proactive delivery are intentionally outside this slice.
- The dedupe database contains opaque routing IDs and bounded response metadata. The separate grant database contains encrypted access/refresh tokens plus opaque principal and grant metadata; the encryption key remains external.
- `logout`, uninstall, relink, maximum-lifetime expiry, refresh uncertainty, and refresh CAS loss immediately remove runtime authority and queue remote revocation. Failed cleanup uses bounded exponential backoff; encrypted tombstones remain only until revocation succeeds or the configured maximum lifetime elapses.
- Stop with `SIGINT` or `SIGTERM` so the SDK server and database close cleanly.

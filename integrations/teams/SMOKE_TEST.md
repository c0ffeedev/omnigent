# Teams personal bot real-tenant smoke test

Use this manual runbook only in an approved, non-production Microsoft 365 test
tenant. Automated tests cover authentication, scope, tenant isolation, and
durable deduplication without requiring a live tenant.

> Never commit credentials. Keep the bot client secret in your shell or secret
> manager. The package ignores `.env`, `*.sqlite3`, and `dist/`.

## Prerequisites

- Node.js 20 or later.
- A test tenant that permits custom-app sideloading.
- A single-tenant Entra app registration and Azure Bot sharing one bot app ID,
  with the Microsoft Teams channel enabled.
- An HTTPS tunnel to the package's local port.
- Permission to install and later remove the custom app.

## Configure and start

Copy `.env.example` to `.env` and set:

- `TEAMS_BOT_APP_ID`: Azure Bot/Entra app UUID.
- `TEAMS_BOT_CLIENT_SECRET`: secret-manager value.
- `TEAMS_BOT_TENANT_ID`: app-registration tenant UUID.
- `TEAMS_ALLOWED_TENANT_IDS`: comma-separated allowed tenant UUIDs, including
  the test tenant.
- `TEAMS_DEDUPE_DATABASE`: local SQLite path, for example
  `./var/teams-dedupe.sqlite3`.
- Optional retention, capacity, and port settings shown in `.env.example`.

From `integrations/teams`:

    npm ci
    npm test
    npm run build
    set -a; . ./.env; set +a
    npm run dev

Expose `PORT` through HTTPS and configure the Azure Bot messaging endpoint as
`https://<tunnel-host>/api/messages`.

## Package and sideload

1. Substitute `TEAMS_APP_ID`, `BOT_APP_ID`, and `BOT_DOMAIN` in
   `appPackage/manifest.json`, or use Microsoft 365 Agents Toolkit substitution
   for the `${{...}}` placeholders.
2. Zip `manifest.json`, `color.png`, and `outline.png` at the archive root.
3. In Teams, upload the custom app and install it for yourself in personal
   scope.

## Verify

1. In a personal chat, send `help`. Expect exactly one bounded static help
   reply. No Omnigent session or model invocation should occur.
2. Send `new`. Expect the bounded response explaining that only `help` is
   available.
3. Confirm the app cannot be installed in a group chat or team. Any
   non-personal activity reaching the endpoint must be rejected.
4. If a second non-allowlisted tenant is available, confirm its activity is
   denied.
5. Confirm Azure/Teams diagnostics show no requested Microsoft Graph
   permissions.

For a real platform redelivery of the same activity ID, inspect durable state:

    sqlite3 "$TEAMS_DEDUPE_DATABASE" \
      "SELECT activity_id, state, receipt, attempt_count FROM activity_operations;"

The activity must have one delivered row and one reply. Restart the process
against the same database before permitting an actual captured activity to be
redelivered; the row and receipt must be reused without a second reply. Sending
the same text again in the Teams UI creates a new activity ID and is not a
deduplication test. Deterministic simultaneous-delivery and restart coverage is
in `tests/activity.test.ts` and `tests/dedupe.test.ts`.

## Cleanup

1. Uninstall and remove the custom Teams app.
2. Delete or rotate the test client secret.
3. Stop the service and HTTPS tunnel.
4. Delete the local dedupe database and `.env` file.

The smoke test passes when personal `help` works once, unsupported commands are
bounded, non-personal/disallowed-tenant activity is refused, durable duplicate
delivery does not send twice, and no Graph permission is present.
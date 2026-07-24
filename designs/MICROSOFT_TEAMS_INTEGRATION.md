# Microsoft Teams integration

Status: proposed

## Context

Omnigent does not have a Microsoft Teams transport. A URL or deep-link helper can
make a session easier to open, but it cannot establish who invoked an action,
which Omnigent principal that person represents, or whether that principal may
access the referenced organization, team, agent, or session.

Teams offers several integration shapes:

- incoming webhooks and Workflows for outbound channel messages;
- Microsoft Graph APIs for activity notifications and chat messages;
- bots and message extensions for authenticated, interactive applications; and
- tabs for embedding a web application.

Those surfaces have materially different identity and permission properties.
Choosing one is therefore an authorization decision, not only a user-interface
choice.

Omnigent already has most of the boundaries needed by a delegated client:

- RFC 8628 device grants bind a non-browser client to an authenticated Omnigent
  user and issue short-lived, revocable delegated tokens;
- organization/team access is resolved server-side from the authenticated user;
  and
- model credentials are selected from the validated `ActorContext` for every
  invocation.

The current delegated `sessions` scope is only a path-prefix allowlist. It
allows every method and subroute under agents, hosts, sessions, and runners,
including operations the Teams client does not need. A narrower server-enforced
method/route scope is therefore a prerequisite, not bridge-side defense in
depth.

The Teams integration must reuse those boundaries rather than introduce a
Teams-specific identity or permission model inside Omnigent.

## Decision

Build Teams as a **lightweight authenticated client**, delivered as a Teams bot
in personal scope first.

The client will support focused Omnigent workflows—account linking, creating a
bot-owned session, exchanging messages, receiving bounded status/completion
notifications, and opening the canonical web session. It will not browse
arbitrary existing sessions, embed the web application, or reimplement the full
Omnigent UI.

This choice is intentionally between the two extremes:

- **Not notification-only.** Notifications are useful, but a webhook or deep
  link alone does not close the actor identity boundary and cannot safely
  support later actions.
- **Not a full collaboration client.** A tab or complete Teams-native session
  browser would duplicate the web application and substantially expand the
  authorization, state synchronization, and support surface before the core
  workflow is validated.

The integration will live outside the core server, following the existing
first-party Slack client boundary. It consumes public Omnigent HTTP/SSE APIs;
it does not add Teams concepts to `AgentSpec`, session resources, or the runner.

## Initial product boundary

### Included

The first usable release is a personal Teams bot with:

- `connect`, `setup`, `status`, `logout`, `new`, `open`, and `help` commands;
- one active Omnigent session per personal Teams conversation;
- an operator-fixed Omnigent server and per-user agent, host, and workspace
  setup;
- message forwarding and streamed response updates;
- Adaptive Cards for login, errors, completion, and links to the canonical web
  session; and
- optional proactive messages only for work initiated through that linked
  personal conversation.

The implementation may coalesce streamed updates to respect Teams throttling,
but Omnigent remains the canonical transcript.

### Deferred

- team/channel and group-chat installation scopes;
- automatic mapping of a Teams team or channel to an Omnigent organization or
  team;
- organization-wide broadcast notifications;
- message extensions, link unfurling, tabs, meetings, and activity-feed
  notifications;
- browsing or administering organizations, teams, members, credentials, or
  users from Teams;
- arbitrary subscription rules for sessions initiated outside the linked
  conversation; and
- Microsoft Graph reads of tenant directory, channel, chat, or message data.

These are separate product and permission decisions. They must not be enabled
only by adding manifest scopes.

## Architecture

```text
Teams client
    | Teams activity + SSO token
    v
Teams channel / Azure Bot Service
    | signed bot activity
    v
integrations/teams
    |-- Teams SDK validates activity transport
    |-- validate and bind Entra principal to the activity sender
    |-- map Teams principal to one encrypted Omnigent device grant
    |-- map personal conversation to active Omnigent session
    |-- translate activities, SSE events, and Adaptive Cards
    |
    | delegated Omnigent bearer token
    v
Omnigent HTTP/SSE APIs
    |-- authenticate Omnigent user
    |-- enforce organization/team/session permissions
    |-- derive validated ActorContext
    v
runner / credential broker
```

The Teams bridge is a confidential, operator-hosted service for Teams app
credentials, but it is an OAuth public client from Omnigent's perspective. It
uses Omnigent device authorization and a new narrow delegated scope rather than
a shared service account.

Use Teams SDK replies and proactive bot messages for transport. Do not use
Microsoft Graph `chatMessage` creation for normal bot traffic: Graph requires a
delegated send permission, while application message creation is restricted to
migration scenarios. Do not use incoming webhooks or Workflows as the primary
transport: they are outbound/channel-oriented, do not establish an Omnigent
actor, and Workflows are owned by individual users and can become orphaned.

The first release requests no Microsoft Graph permissions. Any future Graph
permission requires a separate decision documenting the exact endpoint,
least-privilege delegated or application scope, data retention, and tenant
administrator consent impact.

## SDK and package boundary

Implement the bridge as a separate TypeScript package under
`integrations/teams` using the generally available Microsoft Teams SDK. Do not
use the archived Bot Framework SDK or deprecated TeamsFx SDK. Teams SDK Python
is still in developer preview, while TypeScript is generally available and is
the supported choice for a new production Teams-only application.

The package owns only Teams transport, external-principal binding, encrypted
routing state, and a narrow Omnigent REST/SSE adapter. It must not import
`omnigent_slack` or its Slack dependencies. It reuses Omnigent protocols and
server authorization semantics, not Slack implementation code. A future shared
client library can be extracted only after both transports demonstrate a stable
common interface.

## Identity binding

Teams identity and Omnigent identity are distinct and are bound explicitly.

1. Teams SDK validates every incoming activity against the configured app ID
   and Microsoft channel credentials. Transport authentication proves the
   activity came through the configured channel; it does not authorize an
   Omnigent action.
2. Teams SSO obtains an Entra token for the invoking user. The bridge validates
   signature, issuer, audience, version, expiry, `tid`, and `oid`, then requires
   the token `(tid, oid)` to equal the signed activity's tenant and
   `from.aadObjectId`. The bot app ID, conversation tenant, activity sender, and
   SSO token must all agree. The activity's display name, email, UPN, and other
   client fields are never identity keys. Guest/federated users are denied in
   v1 unless their resource-tenant `tid` is explicitly allowlisted.
3. On an accounts-auth Omnigent server, the user starts the existing device
   authorization flow. Approval occurs in an authenticated Omnigent browser
   session and names the client and new narrow delegated scope. OIDC CLI-ticket
   session JWTs and header/proxy identity are not accepted in v1 because they do
   not provide the same revocable, least-privilege grant. Supporting either mode
   requires a server-side delegated consent flow with equivalent constraints.
4. The bridge stores a binding from `(bot_app_id, tenant_id, object_id,
   omnigent_server_url)` to that Omnigent grant. Access and refresh tokens are
   encrypted at rest, rotated through the existing token endpoint, and deleted
   after revocation or logout.
5. Every Omnigent request uses the linked user's delegated bearer token. The
   server-derived Omnigent user is the actor; Teams claims are correlation
   metadata only and never populate or override `ActorContext`.

A deployment must configure accepted Entra tenant IDs. A missing or disallowed
`tenant_id`, a missing `object_id`, an unlinked account, token validation
failure, or revoked/expired Omnigent grant fails closed and yields a login or
access-denied card.

Email-address matching is explicitly prohibited. It is mutable, can differ
between systems, and would silently collapse two independently authenticated
identities into one authority.

The Omnigent origin is operator-configured and is never accepted from a Teams
message, card submission, link, or Entra claim. Production permits a normalized
HTTPS origin with no path, query, fragment, or userinfo. Plain HTTP is limited
to explicit loopback development. The HTTP client does not follow redirects for
OAuth or authenticated API requests and never forwards a token or client secret
to a different origin.

## Delegated scope prerequisite

Before the bridge can receive an Omnigent token, the server must add a distinct
method-and-route scope for interactive first-party clients. It permits only:

- `GET /health`, `GET /v1/me`, `GET /v1/agents`, and `GET /v1/hosts`;
- `GET /v1/hosts/{host_id}/filesystem`;
- `POST /v1/sessions` and `GET /v1/sessions/{session_id}`;
- `POST /v1/sessions/{session_id}/events`;
- `GET /v1/sessions/{session_id}/stream` and
  `GET /v1/sessions/{session_id}/items`;
- `POST /v1/sessions/{session_id}/elicitations/{elicitation_id}/resolve`;
- `POST /v1/hosts/{host_id}/runners` and
  `GET /v1/runners/{runner_id}/status`; and
- the token refresh/revoke operations required by the grant itself.

Path parameters are matched structurally, not by prefix. Method mismatches,
suffixes, nested subroutes, administration, sharing/grant changes, host
filesystem writes, runner-token minting, and all unlisted routes fail closed.
The scope is enforced by Omnigent after JWT validation; a bridge-side route
allowlist is additional defense only. Tests must enumerate every allowed pair
and representative adjacent denials.

## Authorization semantics

Teams membership grants no Omnigent permission.

- A Teams tenant is not an Omnigent organization.
- A Teams team is not an Omnigent team.
- A Teams channel, chat, or conversation is not an Omnigent session ACL.
- Installing the app grants no read, create, run, share, or administrative
  access in Omnigent.

For every user action, the bridge calls Omnigent with that user's delegated
token. Omnigent then applies the same current checks used by web/API clients:

- agent visibility comes from owner, organization, and Omnigent team access;
- team membership is resolved from the authenticated Omnigent user at request
  time;
- session access and mutations are checked against the session and agent
  resources; and
- model execution receives only the server-validated actor, preserving
  actor-aware credential selection.

The first release creates new sessions only. Each session is owned by the
linked Omnigent user who invoked `new`; it cannot attach an existing session,
act through a public or direct share, administer resources, or adopt another
user's session. A second linked user receives the same non-disclosing denial for
an owned session regardless of Teams membership. Omnigent team membership may
change which agents are discoverable for a future `new`, but under the current
permission model removing team membership does not revoke an already-created
session from its owner. Tests must assert these exact actors and outcomes rather
than treating team membership as session inheritance.

The bridge must not cache a positive Omnigent authorization decision across
requests. It may cache non-authoritative presentation data, but the server must
re-evaluate current ownership, grants, agent visibility, team membership, and
grant revocation on the routes where each is authoritative.

A conversation/session mapping is only a routing hint. Before forwarding a
message, rendering protected details, or sending a proactive notification, the
bridge performs an authenticated Omnigent request for the mapped resource. On
`401` it enters the serialized refresh path once and otherwise requires
relinking; on `403` or `404` it clears the mapping and reveals no protected
resource details.

`setup` stores the user's accessible agent, host, and workspace defaults.
`new` creates a fresh owned session from those defaults and atomically replaces
the active mapping. If the current session has a running turn, replacement
requires explicit confirmation; it never cancels or transfers that session.
`open` links only the active bot-created session. There is no existing-session
picker in v1.

## Teams scope rules

Personal scope is the only supported scope initially. It provides an
unambiguous invoking user and is supported by Teams bot SSO.

When group chat is considered later, each activity must still be authorized as
the individual user who invoked it. A grant owned by one participant must never
be used for another participant. Shared output must be treated as disclosure to
every chat participant and therefore needs a product-level sharing rule, not
just individual access.

Channel scope is further deferred because Teams bot SSO is not supported there
and channel visibility does not correspond to Omnigent resource visibility. A
future channel design must define an explicit Omnigent resource binding, who may
create it, how membership drift is handled, and what content is safe to post to
the whole channel.

## Stored state and secrets

The bridge stores only the state required for routing and revocation:

- validated Teams principal key and tenant;
- the configured Omnigent origin and encrypted delegated tokens;
- Omnigent grant identifier, token generation, expiry, and cleanup state;
- personal conversation reference; and
- active Omnigent session ID owned by that conversation's linked user.

Bot credentials, Entra application credentials, and the token-encryption key
come from deployment secret management and are never stored in the database or
logged. Raw Teams SSO tokens, Omnigent bearer tokens, message bodies, model
credentials, and Adaptive Card submissions must not appear in logs. Audit and
error correlation uses opaque request, activity, session, grant, and actor IDs.

Logout, relink, uninstall, and conversation removal immediately disable the
binding for runtime use and enqueue revocation. Successful revocation deletes
encrypted token material. If the server is unreachable, the row remains a
`revocation_pending` tombstone with encrypted refresh material available only
to the cleanup worker; normal request paths cannot resolve it. Cleanup retries
with bounded backoff until revocation succeeds or the grant's maximum lifetime
passes, then erases the tombstone. Relinking first retires the old grant and
never silently reactivates it.

## Token refresh concurrency

Refresh-token rotation is serialized per binding in the durable store. A worker
acquires a lease, re-reads the current token generation, performs one exchange,
and compare-and-swaps the returned pair into the next generation. Other workers
wait, then use the committed access token; they never replay the prior refresh
token. The lease and generation are scoped by bot app, Teams tenant/principal,
and configured Omnigent origin.

A process crash after the server rotates but before the new pair commits cannot
be recovered with the current OAuth endpoint. The safe v1 behavior is to mark
the binding unusable and require relinking; it must not retry the old refresh
token or oscillate between credentials. Tests cover two workers racing, stale
lease takeover, compare-and-swap loss, and the crash/relink path. Seamless crash
recovery requires a separately designed idempotent server refresh protocol.

## Failure and delivery behavior

- A Teams acknowledgement is sent within the platform response window; long
  work continues asynchronously and updates the bot message.
- Duplicate and retried activities use a durable dedupe key of bot app, tenant,
  conversation, sender, and activity ID. Claiming the key and recording the
  resulting session/turn operation are atomic. Records outlive the Teams retry
  window; multi-replica and restart tests prove retries cannot create duplicate
  sessions, turns, runner launches, elicitations, or model charges.
- Only the owner of the linked personal conversation may continue its active
  session.
- Proactive messages require a stored conversation reference and installed app.
  Teams `403` blocked/uninstalled responses disable that destination.
- No notification contains prompt text, assistant content, tool arguments, or
  elicitation values by default. It contains status, a session label, and an
  Omnigent link after a fresh authorization check.
- Transport, authentication, and authorization failures are distinct. The user
  gets a bounded remediation message; internal exceptions and credentials are
  not returned.

## Implementation sequence

Each slice is independently reviewable and must pass mocked contract tests. A
separate tenant smoke test is manual and does not replace deterministic tests.

### 1. Server-enforced interactive-client scope

Replace path-prefix delegation for the Teams grant with the exact method/route
matrix above. Add positive and adjacent-negative tests, consent-page scope text,
and audit claims. No Teams runtime is required for this server-only slice.

### 2. Teams SDK runtime and authenticated personal help

Create the TypeScript `integrations/teams` package, personal-only manifest,
configuration validation, Teams SDK ingress, and `help`. Prove signed transport,
app/tenant constraints, durable activity dedupe, and no Graph permissions. This
slice has no Omnigent token or session functionality.

### 3. Principal binding and accounts-mode token lifecycle

Add Entra SSO principal/activity binding, operator-fixed Omnigent origin,
accounts-mode device authorization, encrypted storage, serialized refresh,
pending-revocation cleanup, and `connect`/`status`/`logout`. Reject OIDC and
header modes explicitly. Contract tests cover token substitution, cross-user
lookup, two-worker refresh, crash/relink, revoke retry, uninstall, and relink.

This slice is complete when a personal Teams user can link and unlink an
accounts-mode Omnigent deployment and every protected call is attributable to
the linked user under the new narrow scope.

### 4. Setup and owned-session lifecycle

Add accessible agent/host/workspace setup, `new`, `open`, and atomic personal
conversation mapping. Only bot-created sessions owned by the linked user are
eligible. Tests cover exact owner/other-user/team-member behavior, running-turn
replacement confirmation, revocation, stale mappings, and duplicate activity
replay. No message streaming or proactive delivery is included.

### 5. Message, SSE, card, and bounded proactive delivery

Forward personal messages, consume SSE, resolve supported elicitations, coalesce
Adaptive Card updates, and send status/completion notifications only for work
started in that conversation. Tests cover restart/multi-replica idempotency,
authorization before render/send, throttling, Teams blocked/uninstalled
responses, content minimization, and two-user isolation.

## Consequences

- Users perform one explicit Omnigent account-linking consent even when Teams
  SSO succeeds. This extra step is necessary because Entra and Omnigent may use
  different identity providers and tenant policies.
- Personal chat provides a useful end-to-end workflow without solving shared
  disclosure semantics prematurely.
- The bridge reuses the device-grant, permission, actor, SSE, and credential
  protocols already exercised by Slack without coupling the packages.
- V1 supports accounts-mode Omnigent deployments only; OIDC and header/proxy
  deployments need an equivalent least-privilege delegated grant first.
- Channel notifications arrive later, but they will not accidentally establish
  an authorization model through deployment configuration.
- A separate service and Teams app registration must be operated, monitored,
  and secured.

## References

- [Teams app capabilities and scopes](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/understand-use-cases)
- [Teams SDK and supported tooling](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/tool-sdk-overview)
- [Teams SDK documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/)
- [Teams bot SSO](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview)
- [Teams proactive bot messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Teams webhooks and connectors](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors)
- [Microsoft Graph chat message creation](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0)
- [Omnigent device authorization](DEVICE_AUTH.md)
- [Omnigent organization/team permissions](ORGANIZATIONS_TEAMS_PERMISSIONS.md)
- [Actor-aware model credential broker](ACTOR_AWARE_MODEL_CREDENTIAL_BROKER.md)
- [Slack client architecture](../integrations/slack/DESIGN.md)

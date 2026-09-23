# Connector Tokens / External Client Authentication (proposed)

**Status: future design, not a current SpecRelay capability.** No connector
tokens, service identities, management endpoints, or connection presets exist
today. Currently, the API and MCP endpoint authenticate through Clerk; stored
API-key and HTTP Bearer credentials authenticate *outbound* requests to imported
APIs, not inbound clients. This document specifies a possible next milestone
for generic headless AI/MCP clients, not an integration with any one product.

## Goals and non-goals

The goal is to let an OWNER authorize a non-human client to discover and invoke
approved MCP tools for a particular workspace, without sharing a human Clerk
session or an upstream API credential. A connector token should identify a
distinct service actor, be bounded by explicit scopes and workspace membership,
be easy to revoke, and leave existing governance authoritative. The vision is
“Connect once. Govern centrally. Use anywhere.” The current product boundary
remains “OpenAPI in. Governed MCP tools out.”

This milestone does **not** replace Clerk for human/operator login, grant
service actors OWNER privileges, create a trusted AI path, or make SpecRelay a
generic HTTP proxy. It does not broaden the existing HTTPS `GET`-only,
no-request-body execution contract. Caller-supplied credentials for upstream
APIs, arbitrary destinations, and policy overrides remain forbidden.

## Proposed trust and authorization model

- Keep Clerk human authentication and OWNER-only catalog, approval, and
  credential management unchanged. Connector tokens are accepted only on the
  workspace MCP endpoint; other API routes remain Clerk-authenticated unless
  separately designed and reviewed.
- Create a distinct, stable service/connector actor ID, never impersonating a
  Clerk user. Bind it to exactly one workspace and a non-OWNER membership
  recognized by the same workspace authorization boundary used by MCP today.
  The data model may generalize membership identity types, but must retain
  workspace predicates and not-found behavior for outsiders. A token's workspace
  and scopes are additional restrictions, never substitutes for membership.
- Start with least-privilege `tools:list` and `tools:call` scopes, granted
  explicitly; consider optional API/operation allowlists only with stable-ID
  semantics and revalidation when specifications change. Discovery must show
  only the intersection of token scope, workspace membership, current catalog,
  and stored approval. Invocation must recheck the same intersection.
- Preserve operation enablement, OWNER approval, default-deny policy, active
  specification checks, managed-credential matching and injection, broker
  network/SSRF protections, bounded results, execution leases and import
  fencing, and append-only audit. A valid token alone never authorizes a tool.
  Service actors cannot create/import APIs, manage upstream credentials, or
  approve operations.

## Token lifecycle and storage

1. **Create:** An authenticated workspace OWNER names the service actor,
   chooses scopes and an optional expiry, and receives a cryptographically
   random, high-entropy bearer token over TLS. Bind its record to one workspace,
   creator, service actor, issuance time, scope set, and optional expiry.
2. **One-time reveal:** Return the full token only in the successful creation or
   rotation response. Provide a copy/download warning; no later API, UI, audit,
   or support workflow can retrieve it. Lost tokens must be rotated.
3. **Rotate:** An OWNER issues a new secret for the same service actor. Prefer
   independent token records with a short, explicit overlap window so clients
   can cut over; allow immediate old-token revocation. Never redisplay the old
   secret. Do not implicitly expand scopes during rotation.
4. **Revoke/expire:** OWNER revocation takes effect for new requests; expiry is
   checked on every request. Recheck token validity and scopes immediately
   before outbound dispatch as well as at authentication; fail closed if the
   record is unavailable. Define the remaining race explicitly: an already
   dispatched call cannot be recalled by revocation. Retain safe audit history.

Store a random, non-secret identifier/prefix for indexed lookup and a one-way
cryptographic hash of the **entire** high-entropy token for verification.
Compare verifiers in constant time; handle unknown identifiers and collisions
without revealing whether an ID exists. Never store plaintext or a decryptable
copy of the token, and never offer recovery. The upstream credential encryption
key is unrelated to token verification. Require sufficient token entropy so a
database leak does not make offline guessing practical.

## Authentication precedence and failure behavior

On the MCP endpoint only, distinguish a connector-token bearer credential from
Clerk's existing session authentication by an explicit token format and
validation path. Preserve normal Clerk cookie/session and Clerk-issued bearer
behavior for humans. A supplied connector token must never fall back to a
browser session if invalid, expired, or revoked; reject ambiguous requests
carrying both a connector token and Clerk credentials. Do not accept a generic
bearer string merely because an `Authorization` header is present.

Return `401` for missing/invalid/expired/revoked credentials without token
existence details, `404` for a workspace outside the authenticated actor's
membership/binding, and `403` for a valid actor lacking the requested MCP scope.
Evaluate limits before expensive verification, and avoid differences in errors
or timing that expose token identifiers. Keep existing MCP protocol metadata,
Origin validation, JSON-RPC validation, and response rules; connector auth does
not change the `POST /api/workspaces/{workspaceId}/mcp` contract or tool
arguments. Do not forward the inbound token or any caller-supplied
`Authorization`, API-key, cookie, or other upstream credential to the broker.

## Request sequence

```text
External AI/MCP client
  -> HTTPS POST /api/workspaces/{workspaceId}/mcp with Connector Token
  -> token format, hash, expiry and revocation validation
  -> service actor + workspace membership + scope resolution
  -> existing MCP discovery / invocation checks
  -> active spec + approval + execution lease / import fencing
  -> policy + managed credentials + network broker / HTTPS GET to upstream API
  -> sanitized result + append-only workspace audit
```

## Proposed management and observability surface

Conceptually, OWNER-only workspace endpoints would create/list token metadata,
rotate, and revoke; list responses contain only safe metadata (name, actor,
scopes, prefix, timestamps, status), never a verifier or secret. An OWNER-only
console view could create a token, show its one-time value, list active/revoked
tokens, and manage rotation/revocation. Client setup guidance and presets can
explain the MCP URL, required protocol headers, and safe token storage without
claiming compatibility with untested clients. Exact routes and UI are deferred
to API design and security review.

Audit creation, rotation, revocation, denied scope, and execution with a
distinct service actor type and stable internal actor ID; do not overload a
Clerk user ID. Preserve workspace-scoped, append-only audit and the current
Execution Logs outcome filters. A future Execution Logs projection may show
safe actor type and display label (for example, “Connector: Reporting Agent”),
but never the token, verifier, full prefix, raw authentication headers, or
arbitrary audit metadata. Failed authentication before workspace resolution
belongs in separately protected, rate-limited security telemetry, not a
fabricated tenant audit event.

## Threats, abuse limits, and logging

| Threat | Required control |
| --- | --- |
| Leaked token or replay | TLS; one-time reveal; narrow scopes; expiry option; rotation/revocation; per-actor audit and limits. Bearer tokens cannot prevent replay after theft. |
| Database leak or guessing | High-entropy random secrets; indexed non-secret identifier plus one-way hash; constant-time verification; lookup and failure-rate limits. |
| Cross-workspace IDOR or confused deputy | Token binds one workspace; verify membership and requested path together; tenant-scoped joins; reject any cross-workspace resource. |
| Scope escalation or stale approval | Recheck scopes, membership, active spec, approval, policy, and lease at invocation; default deny. |
| Brute force, enumeration, or resource exhaustion | Rate limits on failed auth and on verified token/workspace calls, bounded request sizes/concurrency, safe generic errors, and alerting. Do not rely on IP alone for shared clients. |
| Secret exfiltration in logs or upstream requests | Redact Authorization, cookies, token prefixes/verifiers, request bodies, URLs with sensitive query values, error details, tracing, and analytics; never forward inbound credentials. |

Limits should cover both authentication attempts (with care for shared/NAT
clients) and authenticated discovery/invocation per actor and workspace. Define
the response to limit exhaustion before rollout; failures must not skip audit
where an authenticated workspace is known. Review logging, crash reports,
reverse proxies, telemetry, and UI clipboard flows for secret exposure.

## Migration, rollout, and acceptance

Future additive migrations may introduce service actors, membership linkage,
token metadata/verifiers/scopes, lifecycle timestamps, and audit actor typing.
Preserve existing Clerk user memberships, approvals, encrypted outbound
credentials, and audit rows. Use tenant-bound keys/constraints and a reversible
rollout plan for new records; never rewrite existing human actor identities.
Backfill must not silently grant service access. A default-off feature flag
can gate token creation and token-authenticated MCP traffic separately. Roll
out to test workspaces first, confirm audit/limits and revocation behavior,
then enable more broadly; flag-off must reject connector tokens without
affecting Clerk access.

Security acceptance criteria include:

- OWNER-only create/rotate/revoke and one-time reveal; MEMBER cannot manage.
- Wrong-workspace, missing membership, missing scope, invalid/expired/revoked
  token, ambiguous credentials, and feature-flag-off all fail closed.
- List and call enforce the same scoped subset; cross-tenant and stale-spec
  attempts never reach the upstream API.
- Existing GET/body, approval/policy, managed-credential, DNS/TLS/SSRF,
  redirect, timeout/size, execution-lease, and audit tests still pass for
  both Clerk and connector actors.
- Rotation overlap and revocation races are covered; logs, errors, responses,
  audit, and telemetry contain no inbound token or outbound secret.
- Rate limits, abuse alerts, and backwards-compatible Clerk paths are
  exercised before enabling production traffic.

## Explicitly deferred

Write methods, request bodies, OAuth/OAuth2/OIDC flows (for upstream APIs or
client federation), protocol adapters beyond MCP, machine-to-machine identity
federation, and automatic authorization from a client's claimed identity are
separate designs. None is implied or delivered by connector tokens.
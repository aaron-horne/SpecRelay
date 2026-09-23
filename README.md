# SpecRelay

SpecRelay is an early open-source project, not a finished commercial SaaS
product. Its vision is a security-first governance and connection layer
between documented APIs and AI systems: connect once, govern centrally, and
make approved capabilities available through supported consumer interfaces.

> Connect once. Govern centrally. Use anywhere.

MCP is the first consumer protocol, not a permanent limit on the project.
Other interfaces are possible future directions, not supported compatibility
today. The current milestone is narrower than the vision:

> Today: OpenAPI in. Governed MCP tools out.

Approved execution remains least-privilege and auditable.

## Why SpecRelay exists

SpecRelay was created by a sales engineer building with AI, not a traditional
software engineer.

AI has made it possible for people who understand customers, workflows, APIs,
and business problems to build things that previously required a full
development team. But connecting those things safely is still harder than it
should be.

SpecRelay is an open-source attempt to make that easier: take a documented API,
turn approved operations into governed MCP tools, and give AI-native builders a
safer path to creating connectors. The longer-term goal is to govern API
connections centrally for AI systems, without treating the current MCP
interface as the only possible consumer.

If you can understand the problem and describe what you want to build, you
should not have to be a career software engineer to participate in the next
generation of connected AI tools.

## What it does today

The current milestone imports bounded OpenAPI JSON/YAML, stores immutable
specification versions, normalizes operations, assigns deterministic baseline
risk, and exposes explicitly approved operations as MCP tools. Execution is
deliberately narrow: only HTTPS `GET` operations without request bodies are
eligible. Declared API-key and HTTP Bearer credentials are supported; imported
operations are disabled by default and require explicit owner approval.

The policy and outbound-request boundary derives destinations from the stored
specification, checks HTTPS and public DNS results, pins the validated address
for TLS, rejects redirects and protected headers, and bounds timeout and
response size. Execution and denials are audited.

## Limits and non-goals

This milestone does not support write methods, request bodies, OAuth/OAuth2/OIDC
flows, caller-supplied authentication headers, unsupported credential schemes,
arbitrary URLs, or generic proxying. It is not a hosted service, a promise of
production readiness, or a guarantee that every OpenAPI document is
compatible. There is no trusted AI path. `READ_LIKE` is descriptive only;
stored approval and policy still govern execution.

The tracked TypeSafe skill is development guidance only; it is not part of the
runtime, request path, trust boundary, or production dependency set. Jev is not
a runtime dependency. A future semantic provider, if introduced, will be
optional, BYOK, disabled by default, and advisory; the core runs without one.

## Identity, tenancy, and credentials

The web console and human API routes use Clerk: Clerk's canonical `auth.userId`
is the principal, and workspace membership scopes every tenant-owned resource.
`OWNER` manages APIs, imports, approvals, and credentials; `MEMBER` can use
only eligible approved tools. Isolation is enforced in application services and
queries (not PostgreSQL RLS), with tenant foreign keys and not-found behavior
for outsiders. Self-hosting currently means supplying and operating your own
Clerk tenant and configuration; a fully self-hosted identity provider is not
built in. An adapter must preserve the same authenticated principal and
authorization boundary.

Connector tokens are an opt-in, default-off alternative for **only** the workspace
MCP endpoint. Set `CONNECTOR_TOKENS_ENABLED=true` after deploying the additive
database migration to enable OWNER-only creation, rotation, revocation, and
service-actor MCP access. With the flag off, human Clerk access is unchanged.
Each connector has a workspace MEMBER identity and an explicit `tools:list`
and/or `tools:call` scope; it cannot manage APIs or credentials. Create tokens
from the workspace console, copy the secret once, and supply it as
`Authorization: Bearer srct_...` to the existing MCP endpoint. The original
token continues to work for up to five minutes after rotation (or its prior
expiry, if sooner); revoke to stop new requests immediately. Already dispatched
calls cannot be recalled. Keep tokens in client secret storage, never in URLs
or client-side code. Per-instance pre-authentication and per-actor request
limits return HTTP 429; deployments with multiple API replicas must also
configure shared ingress limits before enabling the flag.

API-key and Bearer secrets are AES-GCM encrypted at rest, bound to workspace,
API source, and destination host, and injected only after authorization and
policy checks. They are never returned or logged. Production requires a
dedicated `CREDENTIAL_ENCRYPTION_KEY` containing exactly 32 random bytes
encoded as base64, plus current key ID/version. Rotation can temporarily
configure an explicit previous key, ID, and version; old ciphertext is
decrypted only to lazily re-encrypt it under the current key. `SESSION_SECRET`
is development/test compatibility only and forbidden in production. See
[SECURITY.md](SECURITY.md) for the boundary and reporting guidance.

## MCP endpoint

Authenticated clients use JSON-RPC 2.0 at:

```text
POST /api/workspaces/{workspaceId}/mcp
```

The endpoint implements the stateless MCP 2026-07-28 Streamable HTTP protocol,
including `server/discover`, `tools/list`, and `tools/call`, with the required
request metadata and protocol headers. Only approved tools from the latest
imported specification are listed. Authentication is provided by the
application's Clerk-authenticated request context or, when explicitly enabled,
a workspace-bound connector token. MCP never accepts caller-supplied upstream
API credentials or forwards inbound authentication headers.

## Local setup

Requirements: Node.js and pnpm, plus PostgreSQL.

```bash
pnpm install
cp .env.example .env
# Set DATABASE_URL and local Clerk values as required by the API/console.
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run migrate
pnpm run check
pnpm run test:security
pnpm run migration:validate
```

`pnpm --filter @workspace/db run migrate` applies the committed PostgreSQL
migrations for local development and CI. Treat migrations as append-only and
validate both a fresh database and an established database with tenant data
before release; do not reset production data. `pnpm run migration:validate`
requires `DATABASE_URL` and fails rather than skipping its PostgreSQL fixtures.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — boundaries and data flow
- [THREAT_MODEL.md](THREAT_MODEL.md) — threats and mitigations
- [SECURITY.md](SECURITY.md) — security policy and private reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and contribution guide
- [ROADMAP.md](ROADMAP.md) — possible future directions, not commitments
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) — controlled release gates
- [LICENSE](LICENSE) — MIT license
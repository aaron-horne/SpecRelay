# Architecture

## Scope

The current milestone is an authenticated OpenAPI ingestion, governance, and restricted execution service. It exposes approved `GET` operations as MCP tools, optionally using declared API-key or HTTP Bearer credentials. It does not execute write methods, accept request bodies, run OAuth flows, accept arbitrary destinations, add new product features, or place AI in a trusted path.

## Package boundaries

```text
artifacts/gateway-console  Browser UI; treats descriptions as text
artifacts/api-server       Express HTTP adapter and application services
lib/api-spec               External HTTP contract and generated clients
lib/core                   Framework-independent normalized domain model
lib/openapi                Bounded parser and OpenApiAdapter implementation
lib/security               Security ports and deterministic policy helpers
lib/db                     PostgreSQL schema and migration source
lib/mcp                    Deterministic tool names and schemas for approved GET operations
```

Routes validate generated request schemas, call services, and validate generated response schemas. Services require workspace context and query tenant-owned rows with the workspace predicate in SQL. Infrastructure libraries are not exposed through the domain model.

## Tenancy and authorization

Clerk's canonical `auth.userId` is the principal. Tenant-owned reads and writes require workspace membership and matching resource IDs; callers outside a workspace receive not-found behavior. `OWNER` is the only role allowed to create APIs, import specifications, manage credentials, or change operation approval. `MEMBER` may read catalog/status and invoke only eligible, approved GET-only MCP tools. Secrets are never returned, and audit visibility is limited to the caller's workspace.

Isolation is application-enforced rather than PostgreSQL RLS: every tenant query carries workspace context, and composite tenant foreign keys bind workspace/API/specification/operation identities so a resource cannot be joined across workspaces. Audit rows are append-only and workspace-scoped.

## Express decision

V0.1 retains the repository's existing Express 5 adapter instead of replacing it with Fastify. Fastify was recommended, not mandated, and replacing the already-provisioned HTTP artifact would add migration risk without strengthening a trust boundary. Express remains isolated to `artifacts/api-server`; validation, parsing, policy, persistence, and domain types do not depend on it. A future adapter replacement therefore does not require rewriting the trusted core.

## Ingestion flow

1. Accept JSON containing the pasted/uploaded document as a bounded string.
2. Reject payloads over the configured byte limit before parsing.
3. Parse JSON directly or YAML with the safe core schema.
4. Reject custom tags, aliases that expand data, excessive nesting/node counts, and non-object roots.
5. Validate the OpenAPI version and required document shape.
6. Inspect `$ref` values without retrieving them; block every remote reference.
7. Detect internal reference cycles without dereferencing.
8. Normalize supported operations into internal domain values.
9. Hash the original document with SHA-256.
10. Persist an immutable specification version, replace the active catalog atomically, and create an append-only audit event. Imports coordinate with execution leases at the database boundary so replacement cannot commit mid-dispatch, including across server instances.

## Execution boundary

`OutboundRequestBroker` is the only outbound execution port. The application service loads the operation and server from the database and constructs the destination; MCP arguments may fill declared path and query parameters but cannot choose a host, scheme, method, or header.

The broker permits only HTTPS `GET`, resolves the stored hostname twice, blocks protected IP ranges and DNS changes, pins a validated address for the TLS connection, preserves the original hostname for certificate validation, refuses redirects, and bounds time and response bytes. Response headers are reduced to a small allowlist and response bodies are never written to the audit log.

`HttpsOutboundRequestBroker` is the live enforcement implementation and reports
validation mode `ENFORCED`. Its default `NodeHttpsGetTransport` opens the TLS
connection after policy and network validation; validated calls use enforced
live execution.

The security integration suite creates an ephemeral local certificate and HTTPS
upstream, then exercises the complete OpenAPI import → approval → MCP discovery
→ invocation → pinned TLS GET → response → audit path. A constructor option
allows only the fixture's exact loopback address in that test instance. The
production construction does not set this option, so protected-address blocking
remains mandatory.

## Credentials

`CredentialProvider` resolves only declared API-key and HTTP Bearer credentials for eligible GET operations. Credential secrets are AES-GCM encrypted with a dedicated production `CREDENTIAL_ENCRYPTION_KEY` containing exactly 32 random bytes encoded as base64. Current ID/version metadata and explicit previous-key ID/version metadata support rotation; old ciphertext may be decrypted and lazily re-encrypted under the current key. A `SESSION_SECRET` fallback exists only for development/test compatibility and is forbidden in production. Key material never enters logs, errors, UI, API responses, MCP output, or audit events.

## Development guidance and optional providers

The tracked TypeSafe skill is development guidance only. It does not run in the
application, participate in requests, affect policy decisions, or form part of
the production dependency or trust boundary. Jev is not a runtime dependency.
Any future semantic-provider interface must be optional, BYOK, disabled by
default, and advisory. Core import, governance, MCP, and execution behavior must
continue to work without it.

## Policy

`PolicyEngine` defaults to `DENY`. Imports create disabled operations and `DENY` policy rows. Explicit enablement records execution approval and approver identity. Discovery and execution independently require the operation to be enabled, approved, and `ALLOW`.

## Audit

Execution records attempts, denials, successes, failures, timeouts, and response-limit violations. Events contain actor and resource identifiers plus bounded result metadata, never request/response bodies or credentials. PostgreSQL rejects updates and deletes of audit rows.

## MCP flow

1. `tools/list` loads only approved operations from each API's latest specification.
2. `tools/call` resolves the deterministic tool name to a workspace-owned operation.
3. The execution service checks membership, method, body, authentication requirements, enablement, and approval.
4. Declared path and query arguments are validated and applied to the stored server and path.
5. The broker re-evaluates policy and network protections before issuing the pinned HTTPS GET.
6. A bounded sanitized result is returned and the outcome is audited.

Before step 5, execution acquires a database-backed lease keyed to the exact workspace, API source, specification version, and operation. The latest-specification check remains in place and is repeated within the lease acquisition boundary. If the operation is stale, the lease cannot be acquired, or the specification no longer matches, execution fails closed without outbound dispatch. The lease is released in a `finally` path after success, failure, or timeout and has an expiry so crashed instances cannot hold it forever.

## Specification history

Specification versions are immutable application records. The active operation catalog points to one version, while previous versions remain available for investigation and change history.

## Execution leases

Execution leases are database records, not process-local locks. Each lease binds `workspaceId`, `apiId`, `specificationId`, and `operationId`, with acquisition and expiry timestamps. Execution holds a shared PostgreSQL session advisory lock for the full dispatch; imports require the matching exclusive transaction advisory lock. This allows concurrent executions while preventing replacement across API-server instances until every dispatch releases its lock. Completion, failure, and timeout release the lease and session lock; database-time expiry cleans rows left by crashed instances. A partial unique index permits only one active specification per workspace/API, and every catalog, MCP, credential, and execution lookup uses that marker. No lease permits a stale specification or changes the GET-only execution boundary.

## Migration compatibility

Migration `0005` is repeatable on both fresh and established schemas. It recognizes structurally equivalent canonical indexes and foreign keys even when legacy names differ, preserves linked tenant data, and adds only safe missing structure. It fails closed on unsafe conflicting definitions or partial objects rather than dropping or resetting them. Release validation covers fresh, reapply, established linked-data, and partial-table fixtures.
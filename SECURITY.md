# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. If GitHub
private vulnerability reporting is enabled for this repository, use that
channel. Otherwise, send a private report to the project maintainers through
the verified private contact channel listed by the repository maintainers. The
repository must not be made public until one of these channels is available and
documented. Do not guess or publish an email address. Include reproduction
steps, affected versions or commits, impact, and suggested mitigation. Do not
include live credentials or private customer data.

Maintainers should acknowledge reports promptly, reproduce them in isolation,
coordinate a fix and disclosure timeline, and credit reporters who request
attribution.

## Security boundary

Clerk's canonical `auth.userId` is the principal. Tenant-owned access requires
workspace membership plus the relevant resource IDs; outsiders receive
not-found behavior. `OWNER` exclusively creates APIs, imports specifications,
manages credentials, and changes operation approval. `MEMBER` can read catalog
and status and use only eligible, approved GET-only MCP tools. Secrets are
never returned, and audit visibility is workspace-scoped and append-only.

Isolation is currently enforced in application services and queries, with
composite tenant foreign keys binding workspace/API/specification/operation
relationships. PostgreSQL RLS is not used.

## Current guarantees

- No arbitrary outbound HTTP execution or generic proxy.
- MCP exposes only explicitly approved operations from the latest stored
  specification.
- Execution supports only HTTPS `GET` without a request body and declared
  API-key or HTTP Bearer credentials.
- Destinations come from the stored OpenAPI server and operation path.
- DNS results are checked for rebinding and protected addresses, then pinned
  for TLS. Redirects and protected caller headers are rejected.
- Timeout and response size are bounded.
- OpenAPI input is bounded; remote references are blocked and never fetched.
- Every tenant-owned query carries workspace context.
- Execution attempts, denials, successes, failures, timeouts, and response
  limit violations are audited; audit records are append-only.
- A database-backed lease and PostgreSQL session lock bind dispatch to the
  exact workspace, API source, active specification version, and operation.
  Replacement imports require the matching exclusive lock.
- Sensitive headers and cookies are redacted from logs.

Credential secrets use AES-GCM at rest and are bound to workspace, API source,
and destination host. Production requires `CREDENTIAL_ENCRYPTION_KEY` with
exactly 32 random bytes encoded as base64. Current ID/version settings identify
the key. Rotation may set
`CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`, `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID`,
and `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION`; previous-key ciphertext is
decrypted only as needed and re-encrypted under the current key. Key material
never appears in logs, errors, UI, API/MCP responses, or audit events.
`SESSION_SECRET` is development/test compatibility only and forbidden in
production.

## Non-goals

Write methods, request bodies, OAuth/OAuth2/OIDC, unsupported credential
schemes, caller-supplied authentication, arbitrary URLs, generic proxying, and
new product features remain outside the current execution boundary. A future
semantic provider is optional BYOK/advisory; the core does not depend on one.

## Credential key rotation

1. Generate a new random 32-byte key and encode it as base64.
2. Configure it as current with a new ID and version; configure the old key as
   the explicit previous key with its exact ID and version.
3. Allow normal credential use to lazily re-encrypt old records.
4. Verify re-encryption, remove all previous-key settings, and deploy again.

Never place key material in source control, logs, errors, UI, API/MCP
responses, or audit events.
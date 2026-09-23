# Roadmap

SpecRelay is an early open-source project. These are possible future directions,
not release promises or commitments. Each item requires design, implementation,
security review, threat-model updates, and regression coverage.

## External Connections / Client Authentication

- **Implemented:** Workspace-bound Connector Tokens provide non-human,
  headless clients with explicit `tools:list` and `tools:call` scopes on the
  workspace MCP endpoint. OWNERs manage creation, one-time reveal, rotation,
  revocation, and optional expiry. Shared database-backed rate limits and
  protected connector security events cover authentication and abuse controls.
  Existing workspace membership, operation approval, policy,
  managed-credential, network, execution-lease, and audit gates remain
  authoritative for every discovery and invocation.
- Connector Tokens are distinct from the API-key and Bearer credentials used
  for outbound API calls. They do not grant OWNER privileges or access to
  non-MCP routes.
- Future work includes client connection guidance and presets, additional
  consumer protocols and broader integrations, without promising compatibility
  with an unimplemented protocol or AI system.

See [Connector Tokens / External Client Authentication](CONNECTOR_TOKENS_DESIGN.md)
for the implemented security and lifecycle design.

## Execution capabilities

- Write methods, with method-specific policy, explicit approval, least-privilege
  credentials, and expanded audit coverage.
- Request bodies, with generated-schema validation, strict content-type rules,
  bounded payloads, and sensitive-field handling.
- OAuth/OAuth2/OIDC, with secure token storage, issuer/audience validation,
  refresh and revocation behavior, and rotation procedures.

## Optional semantic assistance

- An optional semantic-provider interface may be explored for advisory
  classification or review assistance.
- Any provider must be BYOK, disabled by default, non-authoritative, and outside
  the trusted execution path.
- Stored approval, tenant authorization, deterministic policy, and outbound
  controls must remain authoritative.
- Core SpecRelay must remain fully functional without a provider. TypeSafe is
  development guidance only, and Jev is not a runtime dependency.

## Current boundary

The current release remains authenticated, HTTPS `GET`-only, and has no request
bodies or OAuth flows. It supports declared API-key and HTTP Bearer credentials
for outbound API calls only, and has no trusted AI path. Connector Tokens are
implemented for the workspace MCP endpoint; the project does not yet provide
additional consumer adapters. Write methods, request bodies, OAuth/OAuth2/OIDC,
and broader identity federation remain future work.
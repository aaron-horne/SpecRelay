# Roadmap

SpecRelay is an early open-source project. These are possible future directions,
not release promises or commitments. Each item requires design, implementation,
security review, threat-model updates, and regression coverage.

## External Connections / Client Authentication

- Explore scoped connector or service credentials for non-human, headless AI
  clients. These are future inbound client credentials, distinct from the
  existing API-key and Bearer credentials used for outbound API calls.
- Bind each service actor to specific workspaces with least-privilege access,
  revocation and rotation, optional expiry, and auditable identity and activity.
  Preserve all existing workspace authorization, operation approval, policy,
  managed-credential, network, and audit gates for every tool invocation.
- Provide client connection guidance and presets for supported integrations
  if and when external client authentication is implemented.
- Explore additional consumer adapters beyond MCP without promising
  compatibility with any protocol or AI system that is not implemented.

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
for outbound API calls only, and has no trusted AI path. It does not yet issue
scoped connector/service credentials or provide additional consumer adapters.
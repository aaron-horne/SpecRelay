# Roadmap

SpecRelay is an early open-source project. These are possible future directions,
not release promises or commitments. Each item requires design, implementation,
security review, threat-model updates, and regression coverage.

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
only, and has no trusted AI path.
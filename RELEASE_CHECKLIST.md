# Release checklist

This checklist records release readiness work. Except where an item explicitly
records a production Publish or smoke check, checking it does not imply
deployment; completed items do not imply general production readiness.

## Source and CI

- [ ] Review the final diff, confirm a clean Git history/tree, and confirm no
      generated secrets or unintended files are present.
- [ ] Run a secret scan over the tree, history, artifacts, and release inputs;
      investigate every finding.
- [ ] Run CI-equivalent lint, typecheck, general tests, security tests, and
      code generation checks.
- [ ] From an isolated clean checkout, run the documented frozen install,
      code generation, checks, security tests, PostgreSQL migration validation,
      and production build; confirm generated output and the tracked tree stay
      clean.
- [ ] Confirm CI is green for the exact commit intended for publication.

## Data, tenancy, and security

- [ ] Validate migrations on a fresh PostgreSQL database, including
      reapplication/idempotence.
- [ ] Validate migrations on an established schema with linked tenant data and
      partial/legacy fixtures; confirm no unsafe reset or data loss.
- [ ] Keep Connector Tokens default-off in tracked configuration; confirm any
      production opt-in is stored in that deployment's untracked secrets,
      not in the public repository or a local `.replit` override.
- [x] Stage 1 of the managed workspace-deletion rollout was Published and
      verified in production: the parent live-marker CHECK and composite UNIQUE
      key, plus nine child live-marker columns and CHECKs, preceded the child
      foreign keys.
- [x] Stage 2 was Published separately with exactly nine live-workspace
      composite foreign keys. Production catalog checks confirmed all nine
      validated and enabled, the Stage 1 foundation intact, and all seven older
      tenant-isolation foreign keys still validated. The hardened semantic
      deletion-readiness gate passed at that nine-child stage; the new
      ten-child gate remains unverified in production. Managed Publish did not replay the
      SQL migration files' defense-in-depth trigger DDL; no table truncation
      was selected for either stage.
- [ ] Phase 1B: keep `SEMANTIC_PROVIDERS_ENABLED` unset/false. Review the
      managed Publish diff before applying it; stage the new
      `semantic_provider_configs` table, its workspace/provider unique key,
      live-marker CHECK, and columns first. In a separate step, stage its
      `(workspace_id, workspace_is_live)` composite foreign key only after
      verifying the existing parent `(id, is_live)` unique key. Select no
      truncation or destructive data operation.
- [ ] Keep `SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS` empty until the schema and
      ownership checks pass. When enabling the global gate, allowlist only the
      approved live workspace UUID(s); malformed lists deny all workspaces.
      A global flag alone does not enable Test or Ready in any workspace.
- [ ] Before retiring a previous credential encryption key, verify *all*
      semantic-provider envelopes, including excluded workspaces, use the
      current key. Owners can refresh encryption without Jev egress or a new
      connection-test success. Retain the previous key until none remain.
      Removing and restoring allowlist eligibility preserves a stored
      future-readiness preference but cannot activate Phase 1A analysis.
- [ ] Before enabling any Phase 1B test, verify the actual staging catalog
      contains the validated/enabled tenth live-workspace FK and CHECK, plus
      the previously verified nine child guards and seven tenant FKs. Confirm
      workspace deletion remains guarded, OWNER access and CSRF work, and no
      automatic Jev calls occur. Only then opt in a deliberately selected
      workspace for an explicit fixed-state, typed-Noul test. Confirm the
      response structure is valid; never threshold its probability. Leave
      semantic analysis off.
- [ ] Run tenant-isolation tests for workspace membership, resource IDs,
      roles, catalog, credentials, audit data, and MCP execution.
- [ ] Verify production Clerk configuration and canonical `auth.userId`
      authentication; confirm any self-hosted identity adaptation preserves
      the same boundary.
- [ ] Generate and store production encryption keys through the approved
      secret manager; verify key ID/version settings and rotation procedure.
- [ ] Confirm `SESSION_SECRET` fallback is not enabled in production.
- [ ] Complete staging smoke tests for import, approval, MCP discovery/call,
      denial paths, audit records, outbound policy, and credential redaction.

## Connector Token production smoke evidence

The following controlled production smoke-test lifecycle was completed for a
workspace-bound Connector Token. It is evidence for this flow only, not a
substitute for the complete release checklist or a claim of general production
readiness:

- [x] OWNER created a token with the intended explicit scope(s); the secret was
      revealed only once.
- [x] The scoped `tools:list` request succeeded with HTTP 200.
- [x] A `tools:call` request outside the token's granted scope was rejected with
      HTTP 403 `SCOPE_DENIED`; no upstream execution occurred.
- [x] OWNER revoked the token.
- [x] Reuse after revocation was rejected with HTTP 401 `UNAUTHENTICATED`.
- [x] Expected evidence was confirmed: creation and revocation audit events,
      denied-scope security/audit evidence, and post-revocation
      `invalid_credential` security evidence, with no post-revocation scope
      denial or execution-attempt audit.

This smoke test does not complete the remaining source/CI, security review,
public-release, or broader integration gates below.

## Workspace-deletion production smoke evidence

The following controlled production checks succeeded. They validate these
specific flows, not general production readiness:

- [x] OWNER-confirmed workspace deletion succeeded with a disposable test
      workspace; this is not a test of every tenant or operational state.
- [x] Retained connector security history survived workspace deletion while
      active connector identity and token records were removed.

These checks do not complete the remaining public-release and broader
integration gates below.

## Public-release checks

- [ ] Check every README, policy, architecture, threat-model, license, and
      external URL/link; remove stale, private, or unsupported claims.
- [ ] Confirm the documented MCP protocol is 2026-07-28 and the documented
      endpoint/authentication behavior matches the release.
- [ ] Verify a working private vulnerability-reporting channel is available
      and documented. Prefer GitHub private vulnerability reporting when the
      repository settings support it; otherwise document a maintainer-managed
      private channel before changing visibility.
- [ ] Confirm visibility change timing and repository settings with the
      authorized maintainers; do not change visibility until sign-off.
- [ ] Record a rollback/checkpoint note: target commit/tag, database migration
      checkpoint, configuration snapshot reference, and the procedure for
      reverting application/database changes. Do not roll back a migration by
      deleting production data.

## After publication

- [ ] Perform post-public verification of repository visibility, files, links,
      release metadata, CI, issue/security-reporting settings, and the
      published source at the intended commit.
- [ ] Record any follow-up findings and owners; this checklist is evidence of
      checks, not evidence that deployment occurred.

## Staging-to-public sequence

1. Record the approved commit/tag and rollback checkpoint.
2. Complete the staging smoke test against production-equivalent Clerk,
   PostgreSQL, and encryption-key configuration.
3. Confirm CI is green for that exact commit and recheck links and repository
   settings.
4. Obtain maintainer sign-off, then change repository visibility.
5. Perform the post-public checks above. If a release-blocking issue appears,
   stop further release actions and use the recorded checkpoint/rollback plan.
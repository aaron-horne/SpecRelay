# Release checklist

This checklist records release readiness work; checking an item does not imply
that deployment has occurred.

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
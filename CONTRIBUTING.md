# Contributing

SpecRelay is an early open-source project. Contributions should keep the
security boundary explicit and the implementation honest about its current
scope.

## Local development

You need Node.js, pnpm, and PostgreSQL. Copy `.env.example` to `.env`, set a
development `DATABASE_URL`, and configure Clerk values when exercising
authenticated routes or the console:

```bash
pnpm install
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
pnpm run check
pnpm run test:security
pnpm run migration:validate
```

`pnpm run check` runs lint, typechecking, and tests. `pnpm run test` runs the
general suite. `pnpm run migration:validate` requires a disposable PostgreSQL
database through `DATABASE_URL` and refuses to skip the database fixtures. Do
not use production credentials or key material locally.

## Scope and expectations

Preserve the centralized outbound execution boundary. Treat OpenAPI
documents, descriptions, URLs, parameters, and upstream responses as
untrusted. Keep route handlers thin and domain logic framework-independent.
Never log credentials, authorization headers, request bodies, or upstream
responses, and add regression coverage for security fixes.

The current scope is approved, authenticated HTTPS `GET` tools without request
bodies, with declared API-key or HTTP Bearer credentials. Do not expand this
into write methods, OAuth, arbitrary URLs, generic proxying, caller-supplied
auth, or a semantic/AI runtime without an explicit design and threat-model
review. The tracked TypeSafe skill is development guidance only and is not part
of the runtime or production dependency set. Jev is not a runtime dependency.

## Code generation and migrations

Regenerate API clients after HTTP contract changes:

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run generate
```

The first command regenerates API clients; the second generates a reviewed
PostgreSQL migration from schema changes. Database changes belong in the
migration source under `lib/db`.
Migrations are append-only: validate a fresh schema, reapplication, and an
established schema containing linked tenant data. Do not drop or reset existing
objects to make a migration pass. Update `ARCHITECTURE.md` and
`THREAT_MODEL.md` when a security-sensitive boundary changes.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md) for private reporting instructions.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const { Pool } = pg;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);
const migrationNames = [
  "0000_majestic_roland_deschain.sql",
  "0001_flawless_living_mummy.sql",
  "0002_chunky_micromacro.sql",
  "0003_greedy_warstar.sql",
  "0004_unknown_gladiator.sql",
  "0005_spooky_inhumans.sql",
  "0006_powerful_hammerhead.sql",
  "0007_tricky_johnny_blaze.sql",
  "0008_repair_connector_safeguards.sql",
  "0009_workspace_deletion_tombstone.sql",
  "0010_reject_deleted_workspace_writes.sql",
  "0011_workspace_live_key_guards.sql",
  "0012_semantic_provider_configs.sql",
  "0013_semantic_analysis_proposals.sql",
  "0014_semantic_proposal_credential_binding.sql",
  "0015_semantic_analysis_preflight_and_source_hash.sql",
  "0016_preflight_live_workspace_guards.sql",
  "0017_preflight_reject_deleted_workspace_writes.sql",
  "0018_short_preflight_workspace_write_guard.sql",
  "0019_semantic_denials_and_preflight_guard_cleanup.sql",
  "0020_semantic_analysis_dispatch_token_kinds.sql",
  "0021_semantic_denial_dispatch_category.sql",
  "0022_preflight_publishable_live_guard.sql",
];

function forSchema(sql: string, schema: string): string {
  return sql
    .replaceAll('"public".', `"${schema}".`)
    .replaceAll("public.", `${schema}.`);
}

async function applyMigrations(
  client: pg.PoolClient,
  schema: string,
  from = 0,
  to = migrationNames.length,
) {
  for (const name of migrationNames.slice(from, to)) {
    const sql = forSchema(
      await readFile(path.join(migrationsDirectory, name), "utf8"),
      schema,
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
  }
}

async function expectConnectorSafeguards(client: pg.PoolClient, validated: boolean) {
  const indexes = await client.query<{
    indexname: string;
    indisunique: boolean;
    columns: string[];
  }>(`
    SELECT cls.relname AS indexname, i.indisunique,
      (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
    FROM pg_index i
    JOIN pg_class cls ON cls.oid = i.indexrelid
    WHERE cls.relnamespace = current_schema()::regnamespace
      AND cls.relname = ANY(ARRAY[
        'connector_actors_workspace_id_unique', 'connector_actors_member_unique',
        'connector_tokens_lookup_unique', 'connector_tokens_workspace_actor_idx'
      ])
      AND i.indisvalid AND i.indisready
    ORDER BY cls.relname
  `);
  expect(indexes.rows).toEqual([
    { indexname: "connector_actors_member_unique", indisunique: true, columns: ["workspace_id", "member_id"] },
    { indexname: "connector_actors_workspace_id_unique", indisunique: true, columns: ["workspace_id", "id"] },
    { indexname: "connector_tokens_lookup_unique", indisunique: true, columns: ["lookup_id"] },
    { indexname: "connector_tokens_workspace_actor_idx", indisunique: false, columns: ["workspace_id", "actor_id"] },
  ]);
  const actorUnique = await client.query<{ conname: string; definition: string }>(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.conrelid = 'connector_actors'::regclass AND c.contype = 'u'
      AND c.conname = 'connector_actors_workspace_id_unique'
      AND c.conindid = to_regclass(format('%I.%I', current_schema(), c.conname))
  `);
  expect(actorUnique.rows).toEqual([{
    conname: "connector_actors_workspace_id_unique",
    definition: "UNIQUE (workspace_id, id)",
  }]);
  const fk = await client.query<{ conname: string; convalidated: boolean; definition: string }>(`
    SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'connector_tokens'::regclass AND contype = 'f'
      AND conname NOT LIKE '%_workspace_live_fk'
  `);
  expect(fk.rows).toEqual([{
    conname: "connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk".slice(0, 63),
    convalidated: validated,
    definition: `FOREIGN KEY (workspace_id, actor_id) REFERENCES connector_actors(workspace_id, id) ON DELETE CASCADE${validated ? "" : " NOT VALID"}`,
  }]);
}

async function expectWorkspaceLiveGuards(client: pg.PoolClient, validated = 10, checkCount = 10) {
  const guards = await client.query<{ fks: number; checks: number }>(`
    SELECT
      (SELECT count(*)::int FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace AND contype = 'f'
         AND conname = ANY(ARRAY[
           'workspace_memberships_workspace_live_fk', 'api_sources_workspace_live_fk',
           'api_spec_versions_workspace_live_fk', 'api_operations_workspace_live_fk',
           'operation_policies_workspace_live_fk', 'credential_metadata_workspace_live_fk',
           'connector_actors_workspace_live_fk', 'connector_tokens_workspace_live_fk',
             'execution_leases_workspace_live_fk', 'semantic_provider_configs_workspace_live_fk',
             'semantic_analysis_proposals_workspace_live_fk', 'semantic_analysis_preflight_tokens_workspace_live_fk'
         ]) AND convalidated) AS fks,
      (SELECT count(*)::int FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace AND contype = 'c'
         AND conname = ANY(ARRAY[
           'workspace_memberships_live_check', 'api_sources_live_check',
           'api_spec_versions_live_check', 'api_operations_live_check',
           'operation_policies_live_check', 'credential_metadata_live_check',
           'connector_actors_live_check', 'connector_tokens_live_check',
             'execution_leases_live_check', 'semantic_provider_configs_live_check',
             'semantic_analysis_proposals_live_check', 'semantic_analysis_preflight_tokens_live_check'
         ])) AS checks
  `);
  expect(guards.rows[0]?.fks).toBe(validated);
   expect(guards.rows[0]?.checks).toBe(checkCount);
  const parent = await client.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_constraint
    WHERE connamespace = current_schema()::regnamespace
      AND conname IN ('workspaces_id_live_unique', 'workspaces_live_marker_check')
  `);
  expect(parent.rows[0]?.count).toBe(2);
}

describe("migration reconciliation", () => {
  it("exports the live-workspace guard as additive declarative SQL", () => {
    const exported = execFileSync(
      "pnpm",
      ["--filter", "@workspace/db", "exec", "drizzle-kit", "export", "--config", "./drizzle.config.ts"],
      { encoding: "utf8" },
    );
    expect(exported.match(/CONSTRAINT "semantic_analysis_preflight_tokens_live_check"/g)).toHaveLength(1);
    expect(exported.match(/ADD CONSTRAINT "semantic_analysis_preflight_tokens_workspace_live_fk"/g)).toHaveLength(1);
    expect(exported).toMatch(
      /FOREIGN KEY \("workspace_id","workspace_is_live"\) REFERENCES "public"\."workspaces"\("id","is_live"\)/,
    );
    expect(exported).toContain('CONSTRAINT "workspaces_live_marker_check"');
    expect(exported).not.toContain("semantic_analysis_preflight_tokens_workspace_id_fkey");
    expect(exported).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(exported).not.toMatch(/\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/i);
  });

  it("contains no destructive migration operations", async () => {
    for (const name of migrationNames) {
      const migration = await readFile(path.join(migrationsDirectory, name), "utf8");
      const permittedGuardCleanup = migration.replace(
        /DROP TRIGGER IF EXISTS "semantic_analysis_preflight_tokens_reject_deleted_workspace_write"\s+ON "semantic_analysis_preflight_tokens";/g,
        "",
      ).replace(
        /DROP TRIGGER IF EXISTS "semantic_preflight_tokens_reject_deleted_workspace_write"\s+ON "semantic_analysis_preflight_tokens";/g,
        "",
      ).replace(
        /DROP CONSTRAINT IF EXISTS "semantic_analysis_preflight_tokens_workspace_id_fkey";/g,
        "",
      ).replace(
        /DROP CONSTRAINT IF EXISTS "semantic_analysis_denial_events_category_check",/g,
        "",
      );
      expect(permittedGuardCleanup).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE)\b/im);
    }
    const hardeningMigration = await readFile(
      path.join(migrationsDirectory, "0005_spooky_inhumans.sql"),
      "utf8",
    );
    expect(hardeningMigration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(hardeningMigration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(hardeningMigration).toContain("pg_index");
  });

  const databaseUrl = process.env.DATABASE_URL;
  const required = process.env.MIGRATION_VALIDATION === "true";
  if (required && !databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set for migration validation; refusing to skip database tests",
    );
  }
  const integration = required || databaseUrl ? it : it.skip;

  integration(
    "keeps the development tenant keys and committed migration journal intact",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        const keys = await pool.query<{
          conname: string;
          convalidated: boolean;
          definition: string;
        }>(`
          SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace AND contype = 'f'
            AND conname = ANY(ARRAY[
              'api_operations_workspace_api_fk',
              'api_operations_workspace_specification_fk',
              'api_spec_versions_workspace_api_fk',
              'credential_metadata_workspace_api_fk',
              'execution_leases_workspace_api_spec_operation_fk',
              'execution_leases_workspace_specification_fk',
              'operation_policies_workspace_operation_fk'
            ])
          ORDER BY conname
        `);
        const expected = [
          ["api_operations_workspace_api_fk", "FOREIGN KEY (workspace_id, api_id) REFERENCES api_sources(workspace_id, id) ON DELETE CASCADE"],
          ["api_operations_workspace_specification_fk", "FOREIGN KEY (workspace_id, api_id, specification_id) REFERENCES api_spec_versions(workspace_id, api_id, id) ON DELETE CASCADE"],
          ["api_spec_versions_workspace_api_fk", "FOREIGN KEY (workspace_id, api_id) REFERENCES api_sources(workspace_id, id) ON DELETE CASCADE"],
          ["credential_metadata_workspace_api_fk", "FOREIGN KEY (workspace_id, api_id) REFERENCES api_sources(workspace_id, id) ON DELETE CASCADE"],
          ["execution_leases_workspace_api_spec_operation_fk", "FOREIGN KEY (workspace_id, api_id, specification_id, operation_id) REFERENCES api_operations(workspace_id, api_id, specification_id, id) ON DELETE CASCADE"],
          ["execution_leases_workspace_specification_fk", "FOREIGN KEY (workspace_id, api_id, specification_id) REFERENCES api_spec_versions(workspace_id, api_id, id) ON DELETE CASCADE"],
          ["operation_policies_workspace_operation_fk", "FOREIGN KEY (workspace_id, operation_id) REFERENCES api_operations(workspace_id, id) ON DELETE CASCADE"],
        ];
        expect(keys.rows.map(({ conname, definition }) => [
          conname, definition.replace(/ NOT VALID$/, ""),
        ])).toEqual(expected);

        const invalid = await pool.query<{ count: string }>(`
          SELECT count(*) AS count
          FROM api_spec_versions s
          LEFT JOIN api_sources a ON a.workspace_id = s.workspace_id AND a.id = s.api_id
          WHERE a.id IS NULL
        `);
        const unvalidated = keys.rows.filter((key) => !key.convalidated).map((key) => key.conname);
        // The preserved development test fixture pre-dates this FK. NOT VALID
        // still enforces new writes; fresh migrated databases must validate all seven.
        expect(unvalidated).toEqual(Number(invalid.rows[0]?.count) > 0
          ? ["api_spec_versions_workspace_api_fk"] : []);

        const journal = JSON.parse(
          await readFile(path.join(migrationsDirectory, "meta/_journal.json"), "utf8"),
        ) as { entries: Array<{ tag: string; when: number }> };
        expect(journal.entries.map(({ tag }) => tag)).toEqual(
          migrationNames.map((name) => name.replace(/\.sql$/, "")),
        );
        const recorded = await pool.query<{ hash: string; created_at: string }>(
          "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
        );
        expect(recorded.rows).toHaveLength(migrationNames.length);
        expect(recorded.rows).toEqual(await Promise.all(migrationNames.map(async (name, i) => ({
          hash: createHash("sha256")
            .update(await readFile(path.join(migrationsDirectory, name)))
            .digest("hex"),
          created_at: String(journal.entries[i]?.when),
        }))));
        const client = await pool.connect();
        try {
          const orphaned = await client.query<{ count: string }>(`
            SELECT count(*) AS count FROM connector_tokens t
            LEFT JOIN connector_actors a ON a.workspace_id = t.workspace_id AND a.id = t.actor_id
            WHERE a.id IS NULL
          `);
          await expectConnectorSafeguards(client, Number(orphaned.rows[0]?.count) === 0);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "backfills a pre-0011 tombstone and rejects live-marker bypasses",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_tombstone_${process.pid}_${Date.now()}`;
      const tombstoneId = "f1000000-0000-4000-8000-000000000001";
      const liveId = "f1000000-0000-4000-8000-000000000002";
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        // 0010 is present, but 0011 has not yet added the live marker.
        await applyMigrations(client, schema, 0, 11);
        await client.query(
          "INSERT INTO workspaces (id, name, deleted_at) VALUES ($1, 'Legacy tombstone', now()), ($2, 'Live workspace', null)",
          [tombstoneId, liveId],
        );

        await applyMigrations(client, schema, 11, 13);
        const marker = await client.query<{ is_live: boolean }>(
          "SELECT is_live FROM workspaces WHERE id = $1",
          [tombstoneId],
        );
        expect(marker.rows).toEqual([{ is_live: false }]);
        await expectWorkspaceLiveGuards(client);

        // A false child marker cannot be used to evade the live-key guard.
        await expect(client.query(
          "INSERT INTO workspace_memberships (workspace_id, workspace_is_live, user_id, role) VALUES ($1, false, 'bypass-user', 'MEMBER')",
          [liveId],
        )).rejects.toThrow();
        await expect(client.query(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, 'deleted-user', 'MEMBER')",
          [tombstoneId],
        )).rejects.toThrow();
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "applies all migrations fresh and reapplies additive migrations",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_fresh_${process.pid}_${Date.now()}`;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await applyMigrations(client, schema, 0, 19);
        await applyMigrations(client, schema, 19, 20);
        await expectConnectorSafeguards(client, true);
        await expectWorkspaceLiveGuards(client, 12, 12);
        const deletedWorkspaceTriggers = await client.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM pg_trigger
          WHERE tgname LIKE '%_reject_deleted_workspace_write'
            AND NOT tgisinternal
            AND tgrelid IN (
              SELECT oid FROM pg_class
              WHERE relnamespace = current_schema()::regnamespace
            )
        `);
        expect(deletedWorkspaceTriggers.rows[0]?.count).toBe(10);
        const preflightGuard = await client.query<{ tgname: string }>(`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'semantic_analysis_preflight_tokens'::regclass AND NOT tgisinternal
          ORDER BY tgname
        `);
        expect(preflightGuard.rows).toEqual([
          { tgname: "semantic_preflight_tokens_reject_deleted_workspace_write" },
        ]);
        const denialAuditConstraints = await client.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM pg_constraint
          WHERE conrelid = 'semantic_analysis_denial_events'::regclass AND contype = 'f'
        `);
        expect(denialAuditConstraints.rows[0]?.count).toBe(0);
        const denialAuditColumns = await client.query<{ column_name: string }>(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'semantic_analysis_denial_events'
          ORDER BY ordinal_position
        `);
        expect(denialAuditColumns.rows.map((row) => row.column_name)).toEqual([
          "id", "actor_id", "request_category", "reason_class", "created_at",
        ]);
        await client.query(
          "INSERT INTO workspaces (id, name, is_live) VALUES ('f0000000-0000-4000-8000-000000000010', 'Live token fixture', true)",
        );
        await client.query(`
          INSERT INTO semantic_analysis_preflight_tokens
            (token_hash, actor_id, workspace_id, workspace_is_live, api_id, operation_id,
             specification_id, document_hash, credential_id, credential_revision,
             payload_digest, expires_at)
          VALUES ('legacy-preflight-hash', 'fixture-user', 'f0000000-0000-4000-8000-000000000010',
                  true, 'f0000000-0000-4000-8000-000000000011',
                  'f0000000-0000-4000-8000-000000000012',
                  'f0000000-0000-4000-8000-000000000013',
                  'fixture-document-hash', 'f0000000-0000-4000-8000-000000000014',
                  1, 'fixture-payload-digest', now() + interval '1 minute')
        `);
        await applyMigrations(client, schema, 20, 21);
        await applyMigrations(client, schema, 21, 22);
        await applyMigrations(client, schema, 22, 23);
        await applyMigrations(client, schema, 22, 23);
        await client.query(`
          INSERT INTO semantic_analysis_denial_events (request_category, reason_class)
          VALUES ('dispatch', 'request_rejected')
        `);
        const legacyToken = await client.query<{ token_kind: string }>(`
          SELECT token_kind FROM semantic_analysis_preflight_tokens
          WHERE token_hash = 'legacy-preflight-hash'
        `);
        expect(legacyToken.rows).toEqual([{ token_kind: "preflight" }]);
        await client.query(`
          INSERT INTO semantic_analysis_preflight_tokens
            (token_hash, token_kind, actor_id, workspace_id, workspace_is_live, api_id, operation_id,
             specification_id, document_hash, credential_id, credential_revision,
             payload_digest, expires_at)
          VALUES ('dispatch-kind-hash', 'dispatch', 'fixture-user', 'f0000000-0000-4000-8000-000000000010',
                  true, 'f0000000-0000-4000-8000-000000000011',
                  'f0000000-0000-4000-8000-000000000012',
                  'f0000000-0000-4000-8000-000000000013',
                  'fixture-document-hash', 'f0000000-0000-4000-8000-000000000014',
                  1, 'fixture-payload-digest', now() + interval '1 minute')
        `);
        await expect(client.query(`
          INSERT INTO semantic_analysis_preflight_tokens
            (token_hash, token_kind, actor_id, workspace_id, workspace_is_live, api_id, operation_id,
             specification_id, document_hash, credential_id, credential_revision,
             payload_digest, expires_at)
          VALUES ('invalid-kind-hash', 'invalid', 'fixture-user', 'f0000000-0000-4000-8000-000000000010',
                  true, 'f0000000-0000-4000-8000-000000000011',
                  'f0000000-0000-4000-8000-000000000012',
                  'f0000000-0000-4000-8000-000000000013',
                  'fixture-document-hash', 'f0000000-0000-4000-8000-000000000014',
                  1, 'fixture-payload-digest', now() + interval '1 minute')
        `)).rejects.toThrow();
        const retainedGuard = await client.query<{ tgname: string }>(`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'semantic_analysis_preflight_tokens'::regclass AND NOT tgisinternal
          ORDER BY tgname
        `);
        expect(retainedGuard.rows).toEqual([]);
        const publishableGuard = await client.query<{
          conname: string; contype: string; convalidated: boolean; definition: string;
        }>(`
          SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = 'semantic_analysis_preflight_tokens'::regclass
            AND (contype = 'f' OR conname = 'semantic_analysis_preflight_tokens_live_check')
          ORDER BY conname
        `);
        expect(publishableGuard.rows).toEqual([
          {
            conname: "semantic_analysis_preflight_tokens_live_check",
            contype: "c", convalidated: true,
            definition: "CHECK ((workspace_is_live = true))",
          },
          {
            conname: "semantic_analysis_preflight_tokens_workspace_live_fk",
            contype: "f", convalidated: true,
            definition: "FOREIGN KEY (workspace_id, workspace_is_live) REFERENCES workspaces(id, is_live) ON DELETE CASCADE",
          },
        ]);
        await client.query(
          "INSERT INTO workspaces (id, name, deleted_at, is_live) VALUES ('f0000000-0000-4000-8000-000000000001', 'Deleted fixture', now(), false)",
        );
        await expect(client.query(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ('f0000000-0000-4000-8000-000000000001', 'fixture-user', 'MEMBER')",
        )).rejects.toThrow();
        await expect(client.query(`
          INSERT INTO semantic_analysis_preflight_tokens
            (token_hash, actor_id, workspace_id, workspace_is_live, api_id, operation_id,
             specification_id, document_hash, credential_id, credential_revision,
             payload_digest, expires_at)
          VALUES ('fixture-token-hash', 'fixture-user', 'f0000000-0000-4000-8000-000000000001',
                  true, 'f0000000-0000-4000-8000-000000000002',
                  'f0000000-0000-4000-8000-000000000003',
                  'f0000000-0000-4000-8000-000000000004',
                  'fixture-document-hash', 'f0000000-0000-4000-8000-000000000005',
                  1, 'fixture-payload-digest', now() + interval '1 minute')
        `)).rejects.toThrow();
        await expect(client.query(`
          INSERT INTO semantic_analysis_preflight_tokens
            (token_hash, actor_id, workspace_id, workspace_is_live, api_id, operation_id,
             specification_id, document_hash, credential_id, credential_revision,
             payload_digest, expires_at)
          VALUES ('fixture-false-live-hash', 'fixture-user', 'f0000000-0000-4000-8000-000000000001',
                  false, 'f0000000-0000-4000-8000-000000000002',
                  'f0000000-0000-4000-8000-000000000003',
                  'f0000000-0000-4000-8000-000000000004',
                  'fixture-document-hash', 'f0000000-0000-4000-8000-000000000005',
                  1, 'fixture-payload-digest', now() + interval '1 minute')
        `)).rejects.toThrow();
        const tenantKeys = await client.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM pg_constraint
          WHERE connamespace = current_schema()::regnamespace
            AND contype = 'f' AND convalidated
            AND conname = ANY(ARRAY[
              'api_operations_workspace_api_fk',
              'api_operations_workspace_specification_fk',
              'api_spec_versions_workspace_api_fk',
              'credential_metadata_workspace_api_fk',
              'execution_leases_workspace_api_spec_operation_fk',
              'execution_leases_workspace_specification_fk',
              'operation_policies_workspace_operation_fk'
            ])
        `);
        expect(tenantKeys.rows[0]?.count).toBe(7);
        const before = await client.query(
          "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace",
        );
        await applyMigrations(client, schema, 5, 6);
        await applyMigrations(client, schema, 7, 8);
        await applyMigrations(client, schema, 8, 13);
        await expectConnectorSafeguards(client, true);
        await expectWorkspaceLiveGuards(client, 12, 12);
        const after = await client.query(
          "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace",
        );
        expect(after.rows[0].count).toBe(before.rows[0].count);
        const lease = await client.query(
          "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'execution_leases'::regclass",
        );
        expect(lease.rows[0].count).toBe(9);
        const connector = await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'connector_tokens'::regclass");
        expect(connector.rows[0].count).toBeGreaterThanOrEqual(2);
        const connectorIndexes = await client.query(`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename IN ('connector_rate_limits', 'connector_security_events')
          ORDER BY indexname
        `);
        expect(connectorIndexes.rows.map((row) => row.indexname)).toEqual([
          "connector_rate_limits_pkey",
          "connector_rate_limits_until_idx",
          "connector_security_events_occurred_at_idx",
          "connector_security_events_pkey",
          "connector_security_events_workspace_occurred_at_idx",
        ]);
        const connectorColumns = await client.query(`
          SELECT table_name, column_name, is_nullable
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('connector_rate_limits', 'connector_security_events')
          ORDER BY table_name, ordinal_position
        `);
        expect(connectorColumns.rows).toEqual([
          { table_name: "connector_rate_limits", column_name: "key_hash", is_nullable: "NO" },
          { table_name: "connector_rate_limits", column_name: "count", is_nullable: "NO" },
          { table_name: "connector_rate_limits", column_name: "until", is_nullable: "NO" },
          { table_name: "connector_security_events", column_name: "id", is_nullable: "NO" },
          { table_name: "connector_security_events", column_name: "occurred_at", is_nullable: "NO" },
          { table_name: "connector_security_events", column_name: "event_type", is_nullable: "NO" },
          { table_name: "connector_security_events", column_name: "workspace_id", is_nullable: "YES" },
          { table_name: "connector_security_events", column_name: "actor_id", is_nullable: "YES" },
        ]);
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "restores missing connector safeguards without discarding orphaned tokens",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_connector_drift_${process.pid}_${Date.now()}`;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await applyMigrations(client, schema, 0, 8);
        await client.query(`
          ALTER TABLE connector_tokens
            DROP CONSTRAINT connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk
        `);
        for (const name of [
          "connector_actors_workspace_id_unique", "connector_actors_member_unique",
          "connector_tokens_lookup_unique", "connector_tokens_workspace_actor_idx",
        ]) {
          await client.query(`DROP INDEX "${schema}"."${name}"`);
        }
        await client.query(`
          INSERT INTO connector_tokens (id, workspace_id, actor_id, lookup_id, verifier, scopes)
          VALUES ('a1000000-0000-4000-8000-000000000001',
                  'a2000000-0000-4000-8000-000000000001',
                  'a3000000-0000-4000-8000-000000000001',
                  'orphan-fixture', 'fixture-verifier', '[]')
        `);
        await applyMigrations(client, schema, 8, 13);
        await applyMigrations(client, schema, 8, 13);
        await expectConnectorSafeguards(client, false);
        await expectWorkspaceLiveGuards(client, 9);
        const preserved = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM connector_tokens WHERE lookup_id = 'orphan-fixture'",
        );
        expect(preserved.rows[0]?.count).toBe(1);
        await expect(client.query(`
          INSERT INTO connector_tokens (workspace_id, actor_id, lookup_id, verifier, scopes)
          VALUES ('a2000000-0000-4000-8000-000000000001',
                  'a3000000-0000-4000-8000-000000000001',
                  'new-orphan', 'fixture-verifier', '[]')
        `)).rejects.toThrow();
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "upgrades an established pre-hardening fixture twice without changing tenant data",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_upgrade_${process.pid}_${Date.now()}`;
      const ids = {
        workspaceA: "10000000-0000-4000-8000-000000000001",
        workspaceB: "10000000-0000-4000-8000-000000000002",
        apiA: "20000000-0000-4000-8000-000000000001",
        apiB: "20000000-0000-4000-8000-000000000002",
        specA: "30000000-0000-4000-8000-000000000001",
        specB: "30000000-0000-4000-8000-000000000002",
        operationA: "40000000-0000-4000-8000-000000000001",
        operationB: "40000000-0000-4000-8000-000000000002",
        policyA: "50000000-0000-4000-8000-000000000001",
        policyB: "50000000-0000-4000-8000-000000000002",
        credentialA: "60000000-0000-4000-8000-000000000001",
        credentialB: "60000000-0000-4000-8000-000000000002",
        auditA: "70000000-0000-4000-8000-000000000001",
        auditB: "70000000-0000-4000-8000-000000000002",
      };
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await applyMigrations(client, schema, 0, 5);

        await client.query(
          "INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)",
          [ids.workspaceA, "Workspace A", ids.workspaceB, "Workspace B"],
        );
        await client.query(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER'), ($1, $3, 'MEMBER'), ($4, $5, 'OWNER')",
          [
            ids.workspaceA,
            "user-a-owner",
            "user-a-member",
            ids.workspaceB,
            "user-b-owner",
          ],
        );
        await client.query(
          "INSERT INTO api_sources (id, workspace_id, name, description) VALUES ($1, $2, 'Source A', 'A source'), ($3, $4, 'Source B', 'B source')",
          [ids.apiA, ids.workspaceA, ids.apiB, ids.workspaceB],
        );
        await client.query(
          `INSERT INTO api_spec_versions
             (id, workspace_id, api_id, version, format, openapi_version, document_hash,
              raw_document, normalized_document, server_urls, validation_warnings, security_schemes)
           VALUES
             ($1, $2, $3, '1.0.0', 'json', '3.0.3', 'hash-a', '{}', '{}', '[]', '[]', '[]'),
             ($4, $5, $6, '1.0.0', 'json', '3.0.3', 'hash-b', '{}', '{}', '[]', '[]', '[]')`,
          [
            ids.specA,
            ids.workspaceA,
            ids.apiA,
            ids.specB,
            ids.workspaceB,
            ids.apiB,
          ],
        );
        await client.query(
          `INSERT INTO api_operations
             (id, workspace_id, api_id, specification_id, method, path, display_name,
              tags, parameters, responses, security_requirements, security_groups, risk)
           VALUES
             ($1, $2, $3, $4, 'GET', '/a', 'Operation A', '[]', '[]', '[]', '[]', '[]', 'READ_LIKE'),
             ($5, $6, $7, $8, 'GET', '/b', 'Operation B', '[]', '[]', '[]', '[]', '[]', 'READ_LIKE')`,
          [
            ids.operationA,
            ids.workspaceA,
            ids.apiA,
            ids.specA,
            ids.operationB,
            ids.workspaceB,
            ids.apiB,
            ids.specB,
          ],
        );
        await client.query(
          `INSERT INTO operation_policies
             (id, workspace_id, operation_id, decision, execution_approved, approved_by)
           VALUES ($1, $2, $3, 'ALLOW', true, 'user-a-owner'),
                  ($4, $5, $6, 'DENY', false, null)`,
          [
            ids.policyA,
            ids.workspaceA,
            ids.operationA,
            ids.policyB,
            ids.workspaceB,
            ids.operationB,
          ],
        );
        await client.query(
          `INSERT INTO credential_metadata
             (id, workspace_id, api_id, scheme_name, credential_type, location, parameter_name,
              label, provider_name, external_reference, destination_host, status,
              secret_ciphertext, secret_iv, secret_auth_tag, key_version, key_id)
           VALUES
             ($1, $2, $3, 'auth-a', 'API_KEY', 'header', 'X-A', 'A credential',
              'test', 'ref-a', 'a.example.test', 'ACTIVE', 'ciphertext-a', 'iv-a', 'tag-a', 1, 'key-a'),
             ($4, $5, $6, 'auth-b', 'API_KEY', 'header', 'X-B', 'B credential',
              'test', 'ref-b', 'b.example.test', 'ACTIVE', 'ciphertext-b', 'iv-b', 'tag-b', 1, 'key-b')`,
          [
            ids.credentialA,
            ids.workspaceA,
            ids.apiA,
            ids.credentialB,
            ids.workspaceB,
            ids.apiB,
          ],
        );
        await client.query(
          `INSERT INTO audit_events
             (id, workspace_id, event_type, resource_type, resource_id, metadata)
           VALUES ($1, $2, 'approval.created', 'operation', $3, '{"tenant":"a"}'),
                  ($4, $5, 'credential.created', 'credential', $6, '{"tenant":"b"}')`,
          [
            ids.auditA,
            ids.workspaceA,
            ids.operationA,
            ids.auditB,
            ids.workspaceB,
            ids.credentialB,
          ],
        );

        // Existing deployments may have created the column and equivalent
        // objects under different names before the migration was journaled.
        await client.query(
          "ALTER TABLE api_spec_versions ADD COLUMN is_active boolean DEFAULT false NOT NULL",
        );
        await client.query(
          "CREATE UNIQUE INDEX legacy_active_spec_idx ON api_spec_versions (workspace_id, api_id) WHERE is_active",
        );
        await client.query(
          `CREATE UNIQUE INDEX legacy_operation_scope_idx
           ON api_operations (workspace_id, api_id, specification_id, id)`,
        );
        await client.query(`
          CREATE TABLE execution_leases (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            workspace_id uuid NOT NULL, api_id uuid NOT NULL,
            specification_id uuid NOT NULL, operation_id uuid NOT NULL,
            acquired_at timestamptz DEFAULT now() NOT NULL, expires_at timestamptz NOT NULL
          )
        `);
        await client.query(
          "CREATE INDEX legacy_lease_expiry_idx ON execution_leases (workspace_id, api_id, expires_at)",
        );
        await client.query(
          `ALTER TABLE execution_leases
             ADD CONSTRAINT legacy_lease_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
             ADD CONSTRAINT legacy_lease_api_fk FOREIGN KEY (api_id) REFERENCES api_sources(id) ON DELETE CASCADE,
             ADD CONSTRAINT legacy_lease_spec_fk FOREIGN KEY (specification_id) REFERENCES api_spec_versions(id) ON DELETE CASCADE,
             ADD CONSTRAINT legacy_lease_operation_fk FOREIGN KEY (operation_id) REFERENCES api_operations(id) ON DELETE CASCADE,
             ADD CONSTRAINT legacy_lease_workspace_spec_fk FOREIGN KEY (workspace_id, api_id, specification_id)
               REFERENCES api_spec_versions(workspace_id, api_id, id) ON DELETE CASCADE,
             ADD CONSTRAINT legacy_lease_workspace_operation_fk FOREIGN KEY
               (workspace_id, api_id, specification_id, operation_id)
               REFERENCES api_operations(workspace_id, api_id, specification_id, id) ON DELETE CASCADE`,
        );
        const before = await client.query(`
          SELECT
            (SELECT count(*)::int FROM workspaces) AS workspaces,
            (SELECT count(*)::int FROM workspace_memberships) AS memberships,
            (SELECT count(*)::int FROM api_sources) AS sources,
            (SELECT count(*)::int FROM api_spec_versions) AS specs,
            (SELECT count(*)::int FROM api_operations) AS operations,
            (SELECT count(*)::int FROM operation_policies) AS policies,
            (SELECT count(*)::int FROM credential_metadata) AS credentials,
            (SELECT count(*)::int FROM audit_events) AS audits
        `);
        const valuesBefore = await client.query(
          `SELECT workspace_id, name AS value FROM api_sources
           UNION ALL SELECT workspace_id, secret_ciphertext FROM credential_metadata
           ORDER BY workspace_id, value`,
        );

        await applyMigrations(client, schema, 5, 6);
        await applyMigrations(client, schema, 5, 6);
        await applyMigrations(client, schema, 6, 7);
        await applyMigrations(client, schema, 7, 8);
        await client.query(
          `INSERT INTO connector_rate_limits (key_hash, count, until)
           VALUES ('fixture-key', 3, now() + interval '1 minute')`,
        );
        await client.query(
          `INSERT INTO connector_security_events
             (id, event_type, workspace_id, actor_id)
           VALUES ('a1000000-0000-4000-8000-000000000001', 'fixture.event', null, null)`,
        );
        await applyMigrations(client, schema, 7, 8);

        const after = await client.query(`
          SELECT
            (SELECT count(*)::int FROM workspaces) AS workspaces,
            (SELECT count(*)::int FROM workspace_memberships) AS memberships,
            (SELECT count(*)::int FROM api_sources) AS sources,
            (SELECT count(*)::int FROM api_spec_versions) AS specs,
            (SELECT count(*)::int FROM api_operations) AS operations,
            (SELECT count(*)::int FROM operation_policies) AS policies,
            (SELECT count(*)::int FROM credential_metadata) AS credentials,
            (SELECT count(*)::int FROM audit_events) AS audits
        `);
        expect(after.rows).toEqual(before.rows);
        const valuesAfter = await client.query(
          `SELECT workspace_id, name AS value FROM api_sources
           UNION ALL SELECT workspace_id, secret_ciphertext FROM credential_metadata
           ORDER BY workspace_id, value`,
        );
        expect(valuesAfter.rows).toEqual(valuesBefore.rows);
        expect((await client.query(
          "SELECT key_hash, count FROM connector_rate_limits",
        )).rows).toEqual([{ key_hash: "fixture-key", count: 3 }]);
        expect((await client.query(
          "SELECT event_type, workspace_id, actor_id FROM connector_security_events",
        )).rows).toEqual([
          { event_type: "fixture.event", workspace_id: null, actor_id: null },
        ]);
        const connectorForeignKeys = await client.query(`
          SELECT count(*)::int AS count
          FROM pg_constraint
          WHERE conrelid IN (
            'connector_rate_limits'::regclass,
            'connector_security_events'::regclass
          ) AND contype = 'f'
        `);
        expect(connectorForeignKeys.rows[0].count).toBe(0);

        const active = await client.query(
          "SELECT workspace_id, api_id, is_active FROM api_spec_versions ORDER BY workspace_id",
        );
        expect(active.rows).toEqual([
          { workspace_id: ids.workspaceA, api_id: ids.apiA, is_active: true },
          { workspace_id: ids.workspaceB, api_id: ids.apiB, is_active: true },
        ]);
        const requiredIndexes = await client.query(`
          SELECT count(*)::int AS count FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN (
              'legacy_active_spec_idx', 'legacy_operation_scope_idx',
              'legacy_lease_expiry_idx', 'execution_leases_workspace_api_expiry_idx'
            )
        `);
        expect(requiredIndexes.rows[0].count).toBe(3);
        const requiredForeignKeys = await client.query(
          "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'execution_leases'::regclass AND contype = 'f'",
        );
        expect(requiredForeignKeys.rows[0].count).toBe(6);
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "reconciles empty and data-bearing partial execution_leases tables",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const base = `migration_validation_partial_${process.pid}_${Date.now()}`;
      const emptySchema = `${base}_empty`;
      const dataSchema = `${base}_data`;
      try {
        await client.query(`CREATE SCHEMA "${emptySchema}"`);
        await client.query(`SET search_path TO "${emptySchema}", public`);
        await applyMigrations(client, emptySchema, 0, 5);
        await client.query(`CREATE TABLE execution_leases (id uuid)`);
        await applyMigrations(client, emptySchema, 5, 6);
        await applyMigrations(client, emptySchema, 5, 6);
        const emptyColumns = await client.query(`
          SELECT count(*)::int AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'execution_leases'
        `);
        expect(emptyColumns.rows[0].count).toBe(7);
        const emptyPrimaryKey = await client.query(
          "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'execution_leases'::regclass AND contype = 'p'",
        );
        expect(emptyPrimaryKey.rows[0].count).toBe(1);

        await client.query(`CREATE SCHEMA "${dataSchema}"`);
        await client.query(`SET search_path TO "${dataSchema}", public`);
        await applyMigrations(client, dataSchema, 0, 5);
        await client.query(`
          CREATE TABLE execution_leases (
            id uuid, workspace_id uuid, api_id uuid, specification_id uuid,
            operation_id uuid, acquired_at timestamptz, expires_at timestamptz
          )
        `);
        const row = [
          "81000000-0000-4000-8000-000000000001",
          "82000000-0000-4000-8000-000000000001",
          "83000000-0000-4000-8000-000000000001",
          "84000000-0000-4000-8000-000000000001",
          "85000000-0000-4000-8000-000000000001",
        ];
        await client.query(
          "INSERT INTO workspaces (id, name) VALUES ($1, 'Partial workspace')",
          [row[1]],
        );
        await client.query(
          "INSERT INTO api_sources (id, workspace_id, name) VALUES ($1, $2, 'Partial source')",
          [row[2], row[1]],
        );
        await client.query(
          `INSERT INTO api_spec_versions
             (id, workspace_id, api_id, version, format, openapi_version, document_hash,
              raw_document, normalized_document, server_urls, validation_warnings, security_schemes)
           VALUES ($1, $2, $3, '1.0.0', 'json', '3.0.3', 'partial-hash', '{}', '{}', '[]', '[]', '[]')`,
          [row[3], row[1], row[2]],
        );
        await client.query(
          `INSERT INTO api_operations
             (id, workspace_id, api_id, specification_id, method, path, display_name,
              tags, parameters, responses, security_requirements, security_groups, risk)
           VALUES ($1, $2, $3, $4, 'GET', '/partial', 'Partial operation',
                   '[]', '[]', '[]', '[]', '[]', 'READ_LIKE')`,
          [row[4], row[1], row[2], row[3]],
        );
        await client.query(
          `INSERT INTO execution_leases
             (id, workspace_id, api_id, specification_id, operation_id, acquired_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 hour')`,
          row,
        );
        await applyMigrations(client, dataSchema, 5, 6);
        await applyMigrations(client, dataSchema, 5, 6);
        const preserved = await client.query(
          "SELECT id, workspace_id, api_id, specification_id, operation_id FROM execution_leases",
        );
        expect(preserved.rows).toEqual([
          {
            id: row[0],
            workspace_id: row[1],
            api_id: row[2],
            specification_id: row[3],
            operation_id: row[4],
          },
        ]);
        const nullability = await client.query(`
          SELECT count(*)::int AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'execution_leases'
            AND is_nullable = 'NO'
        `);
        expect(nullability.rows[0].count).toBe(7);
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${dataSchema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "fails explicitly for a conflicting canonical execution_leases object",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_conflict_${process.pid}_${Date.now()}`;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await applyMigrations(client, schema, 0, 5);
        await client.query(
          "CREATE VIEW execution_leases AS SELECT 1 AS unrelated_value",
        );
        await expect(applyMigrations(client, schema, 5, 6)).rejects.toThrow(
          /canonical object exists but is not a table/,
        );
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
    30_000,
  );

  integration(
    "fails closed on incompatible lease column types and unvalidated tenant constraints",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const typeSchema = `migration_validation_types_${process.pid}_${Date.now()}`;
      const constraintSchema = `${typeSchema}_constraint`;
      try {
        await client.query(`CREATE SCHEMA "${typeSchema}"`);
        await client.query(`SET search_path TO "${typeSchema}", public`);
        await applyMigrations(client, typeSchema, 0, 5);
        await client.query(`
          CREATE TABLE execution_leases (
            id uuid, workspace_id uuid, api_id uuid, specification_id uuid,
            operation_id uuid, acquired_at text, expires_at timestamptz
          )
        `);
        await expect(applyMigrations(client, typeSchema, 5, 6)).rejects.toThrow(
          /incompatible PostgreSQL type/,
        );

        await client.query(`CREATE SCHEMA "${constraintSchema}"`);
        await client.query(`SET search_path TO "${constraintSchema}", public`);
        await applyMigrations(client, constraintSchema, 0, 5);
        await client.query(`
          CREATE TABLE execution_leases (
            id uuid PRIMARY KEY, workspace_id uuid NOT NULL, api_id uuid NOT NULL,
            specification_id uuid NOT NULL, operation_id uuid NOT NULL,
            acquired_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
          )
        `);
        await client.query(`
          INSERT INTO execution_leases
            (id, workspace_id, api_id, specification_id, operation_id, acquired_at, expires_at)
          VALUES
            ('91000000-0000-4000-8000-000000000001',
             '92000000-0000-4000-8000-000000000001',
             '93000000-0000-4000-8000-000000000001',
             '94000000-0000-4000-8000-000000000001',
             '95000000-0000-4000-8000-000000000001',
             now(), now() + interval '1 hour')
        `);
        await client.query(`
          ALTER TABLE execution_leases
            ADD CONSTRAINT misleading_not_valid_tenant_fk
            FOREIGN KEY (workspace_id, api_id, specification_id)
            REFERENCES api_spec_versions (workspace_id, api_id, id)
            NOT VALID
        `);
        await expect(
          applyMigrations(client, constraintSchema, 5, 6),
        ).rejects.toThrow(
          /violates foreign key constraint|still contains invalid rows|not valid/i,
        );
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${typeSchema}" CASCADE`);
        await client.query(
          `DROP SCHEMA IF EXISTS "${constraintSchema}" CASCADE`,
        );
        client.release();
        await pool.end();
      }
    },
    30_000,
  );
});

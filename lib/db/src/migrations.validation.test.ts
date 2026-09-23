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

describe("migration reconciliation", () => {
  it("contains no destructive migration operations", async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, "0005_spooky_inhumans.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE)\b/im);
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration).toContain("pg_index");
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
    "applies 0000-0006 fresh and reapplies 0005",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl });
      const client = await pool.connect();
      const schema = `migration_validation_fresh_${process.pid}_${Date.now()}`;
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await applyMigrations(client, schema);
        const before = await client.query(
          "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace",
        );
        await applyMigrations(client, schema, 5, 6);
        const after = await client.query(
          "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace = current_schema()::regnamespace",
        );
        expect(after.rows[0].count).toBe(before.rows[0].count);
        const lease = await client.query(
          "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'execution_leases'::regclass",
        );
        expect(lease.rows[0].count).toBe(7);
        const connector = await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'connector_tokens'::regclass");
        expect(connector.rows[0].count).toBeGreaterThanOrEqual(2);
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

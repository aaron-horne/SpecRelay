-- Additive live-tenant keys make workspace deletion safe even when trigger DDL
-- is not surfaced by the managed Publish schema diff.
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "is_live" boolean NOT NULL DEFAULT true;

-- A database already using tombstones must retain its historical rows while
-- bringing the new marker into agreement with deleted_at before the CHECK.
UPDATE "workspaces"
SET "is_live" = false
WHERE "deleted_at" IS NOT NULL AND "is_live" IS DISTINCT FROM false;

ALTER TABLE "workspace_memberships" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "api_sources" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "api_spec_versions" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "api_operations" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "operation_policies" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "credential_metadata" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "connector_actors" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "connector_tokens" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
ALTER TABLE "execution_leases" ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspaces'::regclass AND conname = 'workspaces_id_live_unique') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_live_unique UNIQUE (id, is_live);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspaces'::regclass AND conname = 'workspaces_live_marker_check') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_live_marker_check CHECK (is_live = (deleted_at IS NULL));
  END IF;
END $$;

DO $$
DECLARE
  table_name text;
  check_name text;
  fk_name text;
  has_invalid boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_memberships', 'api_sources', 'api_spec_versions',
    'api_operations', 'operation_policies', 'credential_metadata',
    'connector_actors', 'connector_tokens', 'execution_leases'
  ] LOOP
    check_name := table_name || '_live_check';
    fk_name := table_name || '_workspace_live_fk';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = table_name::regclass AND conname = check_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (workspace_is_live = true)',
        table_name, check_name
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = table_name::regclass AND conname = fk_name
    ) THEN
      EXECUTE format(
        'SELECT EXISTS (
           SELECT 1 FROM %I c
           LEFT JOIN workspaces w
             ON w.id = c.workspace_id AND w.is_live = c.workspace_is_live
           WHERE w.id IS NULL
         )', table_name
      ) INTO has_invalid;
      IF has_invalid THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id, workspace_is_live) REFERENCES workspaces (id, is_live) ON DELETE CASCADE NOT VALID',
          table_name, fk_name
        );
      ELSE
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id, workspace_is_live) REFERENCES workspaces (id, is_live) ON DELETE CASCADE',
          table_name, fk_name
        );
      END IF;
    END IF;
  END LOOP;
END $$;
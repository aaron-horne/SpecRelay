CREATE OR REPLACE FUNCTION reject_deleted_workspace_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM workspaces
  WHERE id = NEW.workspace_id
    AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace is deleted or missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_memberships',
    'api_sources',
    'api_spec_versions',
    'api_operations',
    'operation_policies',
    'credential_metadata',
    'connector_actors',
    'connector_tokens',
    'execution_leases'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = table_name::regclass
        AND tgname = table_name || '_reject_deleted_workspace_write'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION reject_deleted_workspace_write()',
        table_name || '_reject_deleted_workspace_write',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
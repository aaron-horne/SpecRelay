DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'semantic_analysis_preflight_tokens'::regclass
      AND tgname = 'semantic_analysis_preflight_tokens_reject_deleted_workspace_write'
  ) THEN
    CREATE TRIGGER semantic_analysis_preflight_tokens_reject_deleted_workspace_write
      BEFORE INSERT OR UPDATE ON semantic_analysis_preflight_tokens
      FOR EACH ROW EXECUTE FUNCTION reject_deleted_workspace_write();
  END IF;
END
$$;
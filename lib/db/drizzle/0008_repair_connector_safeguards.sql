-- Reconcile schemas created before all of 0006's indexes and token FK were
-- installed. Existing data is never removed or reassigned. A NOT VALID FK
-- protects new writes when historical orphan tokens prevent validation.
DO $$
DECLARE
  wanted record;
  table_oid oid;
  canonical_oid oid;
  equivalent_oid oid;
  actor_unique oid;
  fk_name text := left('connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk', 63);
  canonical_fk oid;
  equivalent_fk oid;
BEGIN
  FOR wanted IN
    SELECT * FROM (VALUES
      ('connector_actors_workspace_id_unique', 'connector_actors', ARRAY['workspace_id', 'id']::text[], true),
      ('connector_actors_member_unique', 'connector_actors', ARRAY['workspace_id', 'member_id']::text[], true),
      ('connector_tokens_lookup_unique', 'connector_tokens', ARRAY['lookup_id']::text[], true),
      ('connector_tokens_workspace_actor_idx', 'connector_tokens', ARRAY['workspace_id', 'actor_id']::text[], false)
    ) AS indexes(name, table_name, columns, must_be_unique)
  LOOP
    table_oid := to_regclass(format('%I.%I', current_schema(), wanted.table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION '0008 requires table %', wanted.table_name;
    END IF;
    canonical_oid := to_regclass(format('%I.%I', current_schema(), wanted.name));
    SELECT i.indexrelid INTO equivalent_oid
    FROM pg_index i
    JOIN pg_class cls ON cls.oid = i.indexrelid
    JOIN pg_am am ON am.oid = cls.relam
    WHERE i.indrelid = table_oid
      AND am.amname = 'btree'
      AND i.indisunique = wanted.must_be_unique
      AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = cardinality(wanted.columns)
      AND i.indnatts = cardinality(wanted.columns)
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
        = wanted.columns
    ORDER BY (i.indexrelid = canonical_oid) DESC
    LIMIT 1;
    IF canonical_oid IS NOT NULL AND canonical_oid IS DISTINCT FROM equivalent_oid THEN
      RAISE EXCEPTION '0008 conflicting canonical index %', wanted.name;
    ELSIF canonical_oid IS NULL AND equivalent_oid IS NOT NULL THEN
      RAISE EXCEPTION '0008 equivalent index for % already exists under another name', wanted.name;
    ELSIF canonical_oid IS NULL THEN
      EXECUTE format('CREATE %sINDEX %I ON %I.%I USING btree (%s)',
        CASE WHEN wanted.must_be_unique THEN 'UNIQUE ' ELSE '' END,
        wanted.name, current_schema(), wanted.table_name,
        (SELECT string_agg(format('%I', column_name), ', ')
         FROM unnest(wanted.columns) AS column_name));
    END IF;
  END LOOP;

  -- Publishing omits a standalone (workspace_id, id) index as redundant with
  -- the id primary key. Attaching the existing index as a UNIQUE constraint
  -- preserves it in the schema diff and supplies the token FK's target.
  SELECT oid INTO actor_unique FROM pg_constraint
  WHERE conrelid = 'connector_actors'::regclass
    AND conname = 'connector_actors_workspace_id_unique';
  IF actor_unique IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.oid = actor_unique AND c.contype = 'u' AND c.convalidated
        AND c.conindid = to_regclass(format('%I.%I', current_schema(), 'connector_actors_workspace_id_unique'))
        AND c.conkey = ARRAY[
          (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id'),
          (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'id')
        ]::smallint[]
    ) THEN
      RAISE EXCEPTION '0008 conflicting canonical connector actor unique constraint';
    END IF;
  ELSE
    ALTER TABLE "connector_actors"
      ADD CONSTRAINT "connector_actors_workspace_id_unique"
      UNIQUE USING INDEX "connector_actors_workspace_id_unique";
  END IF;

  SELECT oid INTO canonical_fk FROM pg_constraint
  WHERE conrelid = 'connector_tokens'::regclass AND conname = fk_name;
  SELECT c.oid INTO equivalent_fk FROM pg_constraint c
  WHERE c.conrelid = 'connector_tokens'::regclass
    AND c.contype = 'f'
    AND c.confrelid = 'connector_actors'::regclass
    AND c.confdeltype = 'c' AND c.confupdtype = 'a'
    AND c.conkey = ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'actor_id')
    ]::smallint[]
    AND c.confkey = ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'workspace_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')
    ]::smallint[]
  ORDER BY (c.oid = canonical_fk) DESC
  LIMIT 1;
  IF canonical_fk IS NOT NULL AND canonical_fk IS DISTINCT FROM equivalent_fk THEN
    RAISE EXCEPTION '0008 conflicting canonical connector token foreign key';
  ELSIF canonical_fk IS NULL AND equivalent_fk IS NOT NULL THEN
    RAISE EXCEPTION '0008 equivalent connector token foreign key already exists under another name';
  ELSIF canonical_fk IS NULL THEN
    ALTER TABLE "connector_tokens"
      ADD CONSTRAINT "connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk"
      FOREIGN KEY ("workspace_id", "actor_id")
      REFERENCES "connector_actors"("workspace_id", "id")
      ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connector_tokens t
    LEFT JOIN connector_actors a ON a.workspace_id = t.workspace_id AND a.id = t.actor_id
    WHERE a.id IS NULL
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'connector_tokens'::regclass AND conname = fk_name AND NOT convalidated
  ) THEN
    ALTER TABLE "connector_tokens"
      VALIDATE CONSTRAINT "connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk";
  END IF;
END
$$;
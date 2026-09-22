-- Reconciliation migration: all statements are safe to re-run against an
-- established database. Active markers are derived from import recency; this
-- intentionally updates that system-owned marker, never user-owned data.
ALTER TABLE "api_spec_versions"
  ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY workspace_id, api_id
      ORDER BY imported_at DESC, id DESC
    ) AS rank
  FROM api_spec_versions
)
UPDATE api_spec_versions AS versions
SET is_active = false
FROM ranked
WHERE versions.id = ranked.id
  AND ranked.rank > 1
  AND versions.is_active;
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY workspace_id, api_id
      ORDER BY imported_at DESC, id DESC
    ) AS rank
  FROM api_spec_versions
)
UPDATE api_spec_versions AS versions
SET is_active = (ranked.rank = 1)
FROM ranked
WHERE versions.id = ranked.id
  AND ranked.rank = 1
  AND NOT versions.is_active;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass(format('%I.%I', current_schema(), 'api_spec_versions_one_active_per_api_unique'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_index AS i
    WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), 'api_spec_versions_one_active_per_api_unique'))
      AND i.indrelid = 'api_spec_versions'::regclass
      AND i.indisunique
      AND regexp_replace(lower(replace(pg_get_expr(i.indpred, i.indrelid), '"', '')), '\s+', '', 'g') = 'is_active'
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id']
  ) THEN
    RAISE EXCEPTION '0005 cannot reconcile api_spec_versions_one_active_per_api_unique: conflicting canonical index';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index AS i
    WHERE i.indrelid = 'api_spec_versions'::regclass
      AND i.indisunique
      AND regexp_replace(lower(replace(pg_get_expr(i.indpred, i.indrelid), '"', '')), '\s+', '', 'g') = 'is_active'
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id']
  ) THEN
    CREATE UNIQUE INDEX "api_spec_versions_one_active_per_api_unique"
      ON "api_spec_versions" USING btree ("workspace_id", "api_id")
      WHERE is_active;
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "api_id" uuid NOT NULL,
  "specification_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  lease_count bigint;
  primary_key_columns smallint[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'execution_leases'::regclass
      AND relkind <> 'r'
  ) THEN
    RAISE EXCEPTION
      '0005 cannot reconcile execution_leases: canonical object exists but is not a table';
  END IF;

  -- Required tenant and resource bindings cannot be inferred for existing
  -- rows. Empty partial tables can be completed safely; populated tables fail
  -- explicitly rather than receiving guessed values.
  SELECT count(*) INTO lease_count FROM execution_leases;
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'execution_leases'::regclass
      AND NOT a.attisdropped
      AND (
        (a.attname IN ('id', 'workspace_id', 'api_id', 'specification_id', 'operation_id')
          AND format_type(a.atttypid, a.atttypmod) <> 'uuid')
        OR (a.attname IN ('acquired_at', 'expires_at')
          AND format_type(a.atttypid, a.atttypmod) <> 'timestamp with time zone')
      )
  ) THEN
    RAISE EXCEPTION
      '0005 cannot reconcile execution_leases: required column has an incompatible PostgreSQL type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'id' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN
      RAISE EXCEPTION '0005 cannot add execution_leases.id: existing rows have no safe identity';
    END IF;
    ALTER TABLE execution_leases ADD COLUMN id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'workspace_id' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN RAISE EXCEPTION '0005 cannot add execution_leases.workspace_id: existing rows lack tenant binding'; END IF;
    ALTER TABLE execution_leases ADD COLUMN workspace_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'api_id' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN RAISE EXCEPTION '0005 cannot add execution_leases.api_id: existing rows lack resource binding'; END IF;
    ALTER TABLE execution_leases ADD COLUMN api_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'specification_id' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN RAISE EXCEPTION '0005 cannot add execution_leases.specification_id: existing rows lack resource binding'; END IF;
    ALTER TABLE execution_leases ADD COLUMN specification_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'operation_id' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN RAISE EXCEPTION '0005 cannot add execution_leases.operation_id: existing rows lack resource binding'; END IF;
    ALTER TABLE execution_leases ADD COLUMN operation_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'acquired_at' AND NOT attisdropped) THEN
    ALTER TABLE execution_leases ADD COLUMN acquired_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'execution_leases'::regclass AND attname = 'expires_at' AND NOT attisdropped) THEN
    IF lease_count > 0 THEN RAISE EXCEPTION '0005 cannot add execution_leases.expires_at: existing rows lack expiry'; END IF;
    ALTER TABLE execution_leases ADD COLUMN expires_at timestamptz;
  END IF;

  IF lease_count > 0 AND EXISTS (SELECT 1 FROM execution_leases
    WHERE id IS NULL OR workspace_id IS NULL OR api_id IS NULL OR specification_id IS NULL
      OR operation_id IS NULL OR acquired_at IS NULL OR expires_at IS NULL) THEN
    RAISE EXCEPTION '0005 cannot reconcile execution_leases: existing rows contain null required values';
  END IF;
  ALTER TABLE execution_leases ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE execution_leases ALTER COLUMN acquired_at SET DEFAULT now();
  IF EXISTS (SELECT 1 FROM execution_leases WHERE id IS NULL) THEN
    RAISE EXCEPTION '0005 cannot create execution_leases primary key: null ids exist';
  END IF;
  IF EXISTS (SELECT 1 FROM execution_leases GROUP BY id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0005 cannot create execution_leases primary key: duplicate ids exist';
  END IF;
  SELECT conkey INTO primary_key_columns
  FROM pg_constraint
  WHERE conrelid = 'execution_leases'::regclass AND contype = 'p';
  IF primary_key_columns IS NOT NULL AND primary_key_columns <> ARRAY[
    (SELECT attnum FROM pg_attribute WHERE attrelid = 'execution_leases'::regclass AND attname = 'id')
  ]::smallint[] THEN
    RAISE EXCEPTION '0005 cannot reconcile execution_leases: conflicting primary key definition';
  END IF;
  IF primary_key_columns IS NULL THEN
    ALTER TABLE execution_leases ADD CONSTRAINT execution_leases_pkey PRIMARY KEY (id);
  END IF;
  ALTER TABLE execution_leases ALTER COLUMN workspace_id SET NOT NULL;
  ALTER TABLE execution_leases ALTER COLUMN api_id SET NOT NULL;
  ALTER TABLE execution_leases ALTER COLUMN specification_id SET NOT NULL;
  ALTER TABLE execution_leases ALTER COLUMN operation_id SET NOT NULL;
  ALTER TABLE execution_leases ALTER COLUMN acquired_at SET NOT NULL;
  ALTER TABLE execution_leases ALTER COLUMN expires_at SET NOT NULL;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass(format('%I.%I', current_schema(), 'api_operations_workspace_api_specification_id_unique'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_index AS i
    WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), 'api_operations_workspace_api_specification_id_unique'))
      AND i.indrelid = 'api_operations'::regclass
      AND i.indisunique
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 4 AND i.indnatts = 4
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id', 'specification_id', 'id']
  ) THEN
    RAISE EXCEPTION '0005 cannot reconcile api_operations_workspace_api_specification_id_unique: conflicting canonical index';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index AS i
    WHERE i.indrelid = 'api_operations'::regclass
      AND i.indisunique
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 4 AND i.indnatts = 4
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id', 'specification_id', 'id']
  ) THEN
    CREATE UNIQUE INDEX "api_operations_workspace_api_specification_id_unique"
      ON "api_operations" USING btree
      ("workspace_id", "api_id", "specification_id", "id");
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass(format('%I.%I', current_schema(), 'execution_leases_workspace_api_expiry_idx'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_index AS i
    WHERE i.indexrelid = to_regclass(format('%I.%I', current_schema(), 'execution_leases_workspace_api_expiry_idx'))
      AND i.indrelid = 'execution_leases'::regclass
      AND i.indisvalid AND i.indisready AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id', 'expires_at']
  ) THEN
    RAISE EXCEPTION '0005 cannot reconcile execution_leases_workspace_api_expiry_idx: conflicting canonical index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'workspaces'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id')]::smallint[]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_workspace_id_workspaces_id_fk"
      FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'api_sources'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'api_id')]::smallint[]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_api_id_api_sources_id_fk"
      FOREIGN KEY ("api_id") REFERENCES "public"."api_sources"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'api_spec_versions'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'specification_id')]::smallint[]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_specification_id_api_spec_versions_id_fk"
      FOREIGN KEY ("specification_id") REFERENCES "public"."api_spec_versions"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'api_operations'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'operation_id')]::smallint[]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_operation_id_api_operations_id_fk"
      FOREIGN KEY ("operation_id") REFERENCES "public"."api_operations"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'api_spec_versions'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'api_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'specification_id')
      ]::smallint[]
      AND c.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'workspace_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'api_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')
      ]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_workspace_specification_fk"
      FOREIGN KEY ("workspace_id", "api_id", "specification_id")
      REFERENCES "public"."api_spec_versions"("workspace_id", "api_id", "id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'execution_leases'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.confrelid = 'api_operations'::regclass AND c.confdeltype = 'c' AND c.confupdtype = 'a'
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'workspace_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'api_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'specification_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'operation_id')
      ]::smallint[]
      AND c.confkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'workspace_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'api_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'specification_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'id')
      ]::smallint[]
  ) THEN
    ALTER TABLE "execution_leases"
      ADD CONSTRAINT "execution_leases_workspace_api_spec_operation_fk"
      FOREIGN KEY ("workspace_id", "api_id", "specification_id", "operation_id")
      REFERENCES "public"."api_operations"("workspace_id", "api_id", "specification_id", "id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indrelid = 'execution_leases'::regclass
      AND indisvalid AND indisready AND indnkeyatts = 3 AND indnatts = 3
      AND indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = indrelid AND a.attnum = k.attnum)
          = ARRAY['workspace_id', 'api_id', 'expires_at']
  ) THEN
    CREATE INDEX "execution_leases_workspace_api_expiry_idx"
      ON "execution_leases" USING btree ("workspace_id", "api_id", "expires_at");
  END IF;
END
$$;
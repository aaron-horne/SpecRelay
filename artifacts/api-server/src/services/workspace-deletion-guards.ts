/**
 * The managed production Publish path installs declarative constraints, not the
 * trigger DDL in migration 0010. These catalog checks must fail closed on a
 * partial or semantically different schema before any deletion is attempted.
 */
type ForeignKeySpec = {
  name: string;
  child: string;
  childColumns: string[];
  parent: string;
  parentColumns: string[];
};

const liveChildren = [
  "workspace_memberships",
  "api_sources",
  "api_spec_versions",
  "api_operations",
  "operation_policies",
  "credential_metadata",
  "connector_actors",
  "connector_tokens",
  "execution_leases",
  "semantic_provider_configs",
  "semantic_analysis_proposals",
  "semantic_analysis_preflight_tokens",
] as const;

const olderTenantKeys: ForeignKeySpec[] = [
  { name: "api_operations_workspace_api_fk", child: "api_operations", childColumns: ["workspace_id", "api_id"], parent: "api_sources", parentColumns: ["workspace_id", "id"] },
  { name: "api_operations_workspace_specification_fk", child: "api_operations", childColumns: ["workspace_id", "api_id", "specification_id"], parent: "api_spec_versions", parentColumns: ["workspace_id", "api_id", "id"] },
  { name: "api_spec_versions_workspace_api_fk", child: "api_spec_versions", childColumns: ["workspace_id", "api_id"], parent: "api_sources", parentColumns: ["workspace_id", "id"] },
  { name: "credential_metadata_workspace_api_fk", child: "credential_metadata", childColumns: ["workspace_id", "api_id"], parent: "api_sources", parentColumns: ["workspace_id", "id"] },
  { name: "execution_leases_workspace_api_spec_operation_fk", child: "execution_leases", childColumns: ["workspace_id", "api_id", "specification_id", "operation_id"], parent: "api_operations", parentColumns: ["workspace_id", "api_id", "specification_id", "id"] },
  { name: "execution_leases_workspace_specification_fk", child: "execution_leases", childColumns: ["workspace_id", "api_id", "specification_id"], parent: "api_spec_versions", parentColumns: ["workspace_id", "api_id", "id"] },
  { name: "operation_policies_workspace_operation_fk", child: "operation_policies", childColumns: ["workspace_id", "operation_id"], parent: "api_operations", parentColumns: ["workspace_id", "id"] },
  { name: "semantic_analysis_proposals_workspace_api_fk", child: "semantic_analysis_proposals", childColumns: ["workspace_id", "api_id"], parent: "api_sources", parentColumns: ["workspace_id", "id"] },
  { name: "semantic_analysis_proposals_specification_fk", child: "semantic_analysis_proposals", childColumns: ["workspace_id", "api_id", "specification_id"], parent: "api_spec_versions", parentColumns: ["workspace_id", "api_id", "id"] },
  { name: "semantic_analysis_proposals_operation_fk", child: "semantic_analysis_proposals", childColumns: ["workspace_id", "api_id", "specification_id", "operation_id"], parent: "api_operations", parentColumns: ["workspace_id", "api_id", "specification_id", "id"] },
];

const liveKeys: ForeignKeySpec[] = liveChildren.map((child) => ({
  name: `${child}_workspace_live_fk`,
  child,
  childColumns: ["workspace_id", "workspace_is_live"],
  parent: "workspaces",
  parentColumns: ["id", "is_live"],
}));

const expectedNames = [
  ...liveKeys.map((key) => key.name),
  ...olderTenantKeys.map((key) => key.name),
  ...liveChildren.map((child) => `${child}_live_check`),
  "workspaces_live_marker_check",
  "workspaces_id_live_unique",
];

// Static, schema-qualified catalog lookup. Column order is taken from conkey /
// confkey ordinality, never from formatted SQL or a constraint's name alone.
export const workspaceGuardConstraintsSql = `
  SELECT c.conname AS "name", c.contype AS "kind",
    current_setting('session_replication_role') AS "replicationRole",
    child.relname AS "child", child.relkind AS "childKind",
    parent.relname AS "parent", parent.relkind AS "parentKind",
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ORDER BY k.ord) AS "childColumns",
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
      ORDER BY k.ord) AS "parentColumns",
    c.convalidated AS "validated", c.condeferrable AS "deferrable",
    c.condeferred AS "deferred", c.confdeltype AS "onDelete",
    c.confupdtype AS "onUpdate", c.confmatchtype AS "matchType",
    CASE WHEN c.contype = 'c' THEN pg_get_expr(c.conbin, c.conrelid) END AS "checkExpression",
    CASE WHEN c.contype = 'u' THEN
      COALESCE(i.indisunique AND i.indisvalid AND i.indisready AND
        i.indrelid = c.conrelid AND i.indpred IS NULL, false)
    END AS "uniqueIndexReady",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.conrelid) AS "childTriggerCount",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.confrelid) AS "parentTriggerCount",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.conrelid
        AND (t.tgtype & 4) <> 0) AS "childInsertCount",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.conrelid
        AND (t.tgtype & 16) <> 0) AS "childUpdateCount",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.confrelid
        AND (t.tgtype & 8) <> 0) AS "parentDeleteCount",
    (SELECT count(*)::int FROM pg_trigger t
      WHERE t.tgconstraint = c.oid AND t.tgisinternal AND t.tgrelid = c.confrelid
        AND (t.tgtype & 16) <> 0) AS "parentUpdateCount",
    (SELECT COALESCE(bool_and(t.tgenabled IN ('O', 'A') AND t.tgisinternal), false)
      FROM pg_trigger t WHERE t.tgconstraint = c.oid) AS "triggersEnabled"
  FROM pg_constraint c
  JOIN pg_class child ON child.oid = c.conrelid
    AND child.relnamespace = current_schema()::regnamespace
  LEFT JOIN pg_class parent ON parent.oid = c.confrelid
    AND parent.relnamespace = current_schema()::regnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.conindid
  WHERE c.connamespace = current_schema()::regnamespace
    AND c.conname = ANY(ARRAY[${expectedNames.map((name) => `'${name}'`).join(", ")}])
`;

export const workspaceGuardColumnsSql = `
  SELECT cls.relname AS "table", cls.relkind AS "tableKind",
    a.attname AS "column", a.attnotnull AS "notNull",
    format_type(a.atttypid, a.atttypmod) AS "dataType"
  FROM pg_class cls
  JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE cls.relnamespace = current_schema()::regnamespace
    AND ((cls.relname = 'workspaces' AND a.attname IN ('id', 'is_live', 'deleted_at'))
      OR (cls.relname = ANY(ARRAY[${liveChildren.map((child) => `'${child}'`).join(", ")}])
        AND a.attname IN ('workspace_id', 'workspace_is_live')))
`;

export type GuardConstraint = {
  name: string;
  kind: string;
  replicationRole: string;
  child: string;
  childKind: string;
  parent: string | null;
  parentKind: string | null;
  childColumns: string[];
  parentColumns: string[];
  validated: boolean;
  deferrable: boolean;
  deferred: boolean;
  onDelete: string | null;
  onUpdate: string | null;
  matchType: string | null;
  checkExpression: string | null;
  uniqueIndexReady: boolean | null;
  childTriggerCount: number;
  parentTriggerCount: number;
  childInsertCount: number;
  childUpdateCount: number;
  parentDeleteCount: number;
  parentUpdateCount: number;
  triggersEnabled: boolean;
};

export type GuardColumn = {
  table: string;
  tableKind: string;
  column: string;
  notNull: boolean;
  dataType: string;
};

function columnsEqual(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((column, i) => column === expected[i]);
}

export function hasWorkspaceDeletionGuards(
  constraints: GuardConstraint[],
  columns: GuardColumn[],
): boolean {
  if (constraints.length !== expectedNames.length || columns.length !== liveChildren.length * 2 + 3) {
    return false;
  }
  const byName = new Map(constraints.map((constraint) => [constraint.name, constraint]));
  const byColumn = new Map(columns.map((column) => [`${column.table}.${column.column}`, column]));
  if (byName.size !== constraints.length || byColumn.size !== columns.length) return false;

  const columnIs = (table: string, name: string, type: string, notNull: boolean) => {
    const column = byColumn.get(`${table}.${name}`);
    return column?.tableKind === "r" && column.dataType === type && column.notNull === notNull;
  };
  if (!columnIs("workspaces", "id", "uuid", true) ||
      !columnIs("workspaces", "is_live", "boolean", true) ||
      !columnIs("workspaces", "deleted_at", "timestamp with time zone", false) ||
      !liveChildren.every((child) =>
        columnIs(child, "workspace_id", "uuid", true) &&
        columnIs(child, "workspace_is_live", "boolean", true))) {
    return false;
  }

  for (const key of [...liveKeys, ...olderTenantKeys]) {
    const constraint = byName.get(key.name);
    if (!constraint || constraint.kind !== "f" ||
        constraint.replicationRole !== "origin" ||
        constraint.child !== key.child || constraint.childKind !== "r" ||
        constraint.parent !== key.parent || constraint.parentKind !== "r" ||
        !columnsEqual(constraint.childColumns, key.childColumns) ||
        !columnsEqual(constraint.parentColumns, key.parentColumns) ||
        !constraint.validated || constraint.deferrable || constraint.deferred ||
        constraint.onDelete !== "c" || constraint.onUpdate !== "a" ||
        constraint.matchType !== "s" ||
        constraint.childTriggerCount !== 2 || constraint.parentTriggerCount !== 2 ||
        constraint.childInsertCount !== 1 || constraint.childUpdateCount !== 1 ||
        constraint.parentDeleteCount !== 1 || constraint.parentUpdateCount !== 1 ||
        !constraint.triggersEnabled) return false;
  }

  for (const child of liveChildren) {
    const check = byName.get(`${child}_live_check`);
    if (!check || check.kind !== "c" || check.child !== child || check.childKind !== "r" ||
        !check.validated || check.checkExpression !== "(workspace_is_live = true)") return false;
  }
  const marker = byName.get("workspaces_live_marker_check");
  if (!marker || marker.kind !== "c" || marker.child !== "workspaces" ||
      marker.childKind !== "r" || !marker.validated ||
      marker.checkExpression !== "(is_live = (deleted_at IS NULL))") return false;

  const unique = byName.get("workspaces_id_live_unique");
  return !!unique && unique.kind === "u" && unique.child === "workspaces" &&
    unique.childKind === "r" && unique.validated && unique.uniqueIndexReady === true &&
    columnsEqual(unique.childColumns, ["id", "is_live"]);
}
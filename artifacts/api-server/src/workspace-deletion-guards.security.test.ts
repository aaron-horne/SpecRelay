import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  hasWorkspaceDeletionGuards,
  workspaceGuardColumnsSql,
  workspaceGuardConstraintsSql,
  type GuardColumn,
  type GuardConstraint,
} from "./services/workspace-deletion-guards";

const liveChildren = [
  "workspace_memberships", "api_sources", "api_spec_versions",
  "api_operations", "operation_policies", "credential_metadata",
  "connector_actors", "connector_tokens", "execution_leases",
  "semantic_provider_configs",
];

describe("production workspace deletion catalog gate", () => {
  let actualConstraints: GuardConstraint[];
  let actualColumns: GuardColumn[];

  beforeAll(async () => {
    const constraints = await db.execute<GuardConstraint>(sql.raw(workspaceGuardConstraintsSql));
    const columns = await db.execute<GuardColumn>(sql.raw(workspaceGuardColumnsSql));
    actualConstraints = constraints.rows;
    actualColumns = columns.rows;
  });

  function fixture() {
    // A preserved historical dev row leaves this one older FK NOT VALID.
    // Correct only the in-memory catalog snapshot; production must validate it.
    const constraints = actualConstraints.map((entry) => ({
      ...entry,
      childColumns: [...entry.childColumns],
      parentColumns: [...entry.parentColumns],
      ...(entry.name === "api_spec_versions_workspace_api_fk" ? { validated: true } : {}),
    }));
    // The managed Stage 1 development database intentionally lacks these
    // FKs. Model the final Stage 2 catalog in memory without altering the
    // development schema; fresh migration-managed databases already have them.
    const template = constraints.find((entry) => entry.name === "api_operations_workspace_api_fk")!;
    for (const child of liveChildren) {
      if (constraints.some((entry) => entry.name === `${child}_workspace_live_fk`)) continue;
      constraints.push({
        ...template,
        name: `${child}_workspace_live_fk`,
        child,
        parent: "workspaces",
        childColumns: ["workspace_id", "workspace_is_live"],
        parentColumns: ["id", "is_live"],
        validated: true,
      });
    }
    const liveCheck = constraints.find((entry) => entry.name === "api_operations_live_check")!;
    for (const child of liveChildren) {
      if (constraints.some((entry) => entry.name === `${child}_live_check`)) continue;
      constraints.push({
        ...liveCheck,
        name: `${child}_live_check`,
        child,
        checkExpression: "(workspace_is_live = true)",
      });
    }
    const columns = actualColumns.map((entry) => ({ ...entry }));
    for (const name of ["workspace_id", "workspace_is_live"]) {
      if (columns.some((entry) =>
        entry.table === "semantic_provider_configs" && entry.column === name
      )) continue;
      const source = columns.find((entry) =>
        entry.table === "workspace_memberships" && entry.column === name
      )!;
      columns.push({ ...source, table: "semantic_provider_configs" });
    }
    return { constraints, columns };
  }

  function rejects(change: (snapshot: ReturnType<typeof fixture>) => void) {
    const snapshot = fixture();
    expect(hasWorkspaceDeletionGuards(snapshot.constraints, snapshot.columns)).toBe(true);
    change(snapshot);
    expect(hasWorkspaceDeletionGuards(snapshot.constraints, snapshot.columns)).toBe(false);
  }

  it("accepts the intended declarative schema, including all seven validated tenant FKs", () => {
    const { constraints, columns } = fixture();
    expect(constraints).toHaveLength(29);
    expect(columns).toHaveLength(23);
    expect(hasWorkspaceDeletionGuards(constraints, columns)).toBe(true);
    // An incomplete Stage 1 catalog or the known historical NOT VALID row
    // must fail closed, even though the complete in-memory fixture passes.
    if (actualConstraints.length !== 29 || actualConstraints.some((row) => !row.validated)) {
      expect(hasWorkspaceDeletionGuards(actualConstraints, actualColumns)).toBe(false);
    }
  });

  it.each(liveChildren)("rejects a same-named live FK on the wrong table: %s", (child) => {
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === `${child}_workspace_live_fk`)!.child = "audit_events";
    });
  });

  it.each(liveChildren)("rejects nullable workspace or live-marker columns: %s", (child) => {
    for (const name of ["workspace_id", "workspace_is_live"]) {
      rejects(({ columns }) => {
        columns.find((row) => row.table === child && row.column === name)!.notNull = false;
      });
    }
  });

  it("rejects a CHECK with the expected name but wrong predicate", () => {
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === "api_sources_live_check")!.checkExpression = "(workspace_is_live IS NOT NULL)";
    });
  });

  it("rejects unvalidated or missing child CHECKs and a wrong parent marker CHECK", () => {
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === "api_sources_live_check")!.validated = false;
    });
    rejects(({ constraints }) => {
      constraints.splice(constraints.findIndex((row) => row.name === "api_sources_live_check"), 1);
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === "workspaces_live_marker_check")!.checkExpression = "(is_live = true)";
    });
  });

  it("rejects wrong columns, references, delete actions, or disabled/unvalidated FK enforcement", () => {
    const name = "api_sources_workspace_live_fk";
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.childColumns = ["workspace_is_live", "workspace_id"];
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parentColumns = ["id", "deleted_at"];
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parent = "api_sources";
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.onDelete = "a";
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.validated = false;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.triggersEnabled = false;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.childTriggerCount = 1;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.childInsertCount = 0;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parentTriggerCount = 1;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parentUpdateCount = 0;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.replicationRole = "replica";
    });
  });

  it("rejects a spoofed or missing parent unique key and nullable parent live marker", () => {
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === "workspaces_id_live_unique")!.childColumns = ["id"];
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === "workspaces_id_live_unique")!.uniqueIndexReady = false;
    });
    rejects(({ columns }) => {
      columns.find((row) => row.table === "workspaces" && row.column === "is_live")!.notNull = false;
    });
  });

  it("rejects missing, unvalidated, disabled, or misdirected older tenant FKs", () => {
    const name = "api_operations_workspace_specification_fk";
    rejects(({ constraints }) => {
      constraints.splice(constraints.findIndex((row) => row.name === name), 1);
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.validated = false;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.triggersEnabled = false;
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parentColumns = ["workspace_id", "id", "api_id"];
    });
    rejects(({ constraints }) => {
      constraints.find((row) => row.name === name)!.parent = "api_sources";
    });
  });
});
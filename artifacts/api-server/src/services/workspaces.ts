import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  auditEventsTable,
  connectorActorsTable,
  executionLeasesTable,
  db,
  workspacesTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import { mapAuditEvent } from "./mappers";
import { ServiceError } from "./errors";

export class WorkspaceService {
  async list(userId: string) {
    return db
      .select({ id: workspacesTable.id, name: workspacesTable.name, createdAt: workspacesTable.createdAt, updatedAt: workspacesTable.updatedAt })
      .from(workspacesTable)
      .innerJoin(workspaceMembershipsTable, eq(workspaceMembershipsTable.workspaceId, workspacesTable.id))
      .where(and(
        eq(workspaceMembershipsTable.userId, userId),
        isNull(workspacesTable.deletedAt),
      ))
      .orderBy(workspacesTable.createdAt);
  }

  async create(name: string, userId: string) {
    return db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspacesTable)
        .values({ name })
        .returning();
      if (!workspace) {
        throw new ServiceError(
          "Workspace could not be created",
          400,
          "WORKSPACE_CREATE_FAILED",
        );
      }
      await tx.insert(workspaceMembershipsTable).values({
        workspaceId: workspace.id,
        userId,
        role: "OWNER",
      });
      await tx.insert(auditEventsTable).values({
        workspaceId: workspace.id,
        eventType: "workspace.created",
        resourceType: "workspace",
        resourceId: workspace.id,
        metadata: { name: workspace.name },
      });
      return workspace;
    });
  }

  async get(workspaceId: string, userId: string) {
    const [workspace] = await db
      .select()
      .from(workspacesTable)
      .innerJoin(workspaceMembershipsTable, eq(workspaceMembershipsTable.workspaceId, workspacesTable.id))
      .where(and(
        eq(workspacesTable.id, workspaceId),
        eq(workspaceMembershipsTable.userId, userId),
        isNull(workspacesTable.deletedAt),
      ))
      .limit(1);
    if (!workspace) {
      throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
    }
    return workspace.workspaces;
  }

  async overview(workspaceId: string, userId: string) {
    const workspace = await this.get(workspaceId, userId);
    const [[membership], [apiTotal], [operationTotal], [enabledTotal], auditRows] =
      await Promise.all([
        db
          .select({ role: workspaceMembershipsTable.role })
          .from(workspaceMembershipsTable)
          .where(and(
            eq(workspaceMembershipsTable.workspaceId, workspaceId),
            eq(workspaceMembershipsTable.userId, userId),
          ))
          .limit(1),
        db
          .select({ value: count() })
          .from(apiSourcesTable)
          .where(eq(apiSourcesTable.workspaceId, workspaceId)),
        db
          .select({ value: count() })
          .from(apiOperationsTable)
          .where(eq(apiOperationsTable.workspaceId, workspaceId)),
        db
          .select({ value: count() })
          .from(apiOperationsTable)
          .where(
            and(
              eq(apiOperationsTable.workspaceId, workspaceId),
              eq(apiOperationsTable.enabled, true),
            ),
          ),
        db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.workspaceId, workspaceId))
          .orderBy(desc(auditEventsTable.createdAt))
          .limit(10),
      ]);

    return {
      workspace,
      role: membership?.role ?? "MEMBER",
      canManage: membership?.role === "OWNER",
      apiCount: apiTotal?.value ?? 0,
      operationCount: operationTotal?.value ?? 0,
      enabledOperationCount: enabledTotal?.value ?? 0,
      recentAuditEvents: auditRows.map(mapAuditEvent),
    };
  }

  async delete(workspaceId: string, userId: string, confirmedName: string): Promise<void> {
    await db.transaction(async (tx) => {
      const result = await tx.execute<{
        id: string;
        name: string;
        role: "OWNER" | "MEMBER";
      }>(sql`
        SELECT w.id, w.name, wm.role
        FROM workspaces w
        JOIN workspace_memberships wm ON wm.workspace_id = w.id
        WHERE w.id = ${workspaceId} AND wm.user_id = ${userId}
          AND w.deleted_at IS NULL
        FOR UPDATE OF w, wm
      `);
      const workspace = result.rows[0];
      if (!workspace) {
        throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
      }
      if (workspace.role !== "OWNER") {
        throw new ServiceError("Workspace owner required", 403, "WORKSPACE_OWNER_REQUIRED");
      }
      if (workspace.name !== confirmedName) {
        throw new ServiceError(
          "Workspace name confirmation does not match",
          400,
          "WORKSPACE_NAME_CONFIRMATION_MISMATCH",
        );
      }

      // Managed Publish does not install SQL-file triggers. Refuse deletion
      // until all declarative live-workspace guards have been installed and
      // validated in this database; a partial schema rollout must fail closed.
      if (process.env.NODE_ENV === "production") {
        const guardResult = await tx.execute<{
          foreignKeys: number;
          childChecks: number;
          parentChecks: number;
          parentKeys: number;
        }>(sql`
          SELECT
            count(*) FILTER (WHERE contype = 'f' AND convalidated AND conname = ANY(ARRAY[
              'workspace_memberships_workspace_live_fk', 'api_sources_workspace_live_fk',
              'api_spec_versions_workspace_live_fk', 'api_operations_workspace_live_fk',
              'operation_policies_workspace_live_fk', 'credential_metadata_workspace_live_fk',
              'connector_actors_workspace_live_fk', 'connector_tokens_workspace_live_fk',
              'execution_leases_workspace_live_fk'
            ]))::int AS "foreignKeys",
            count(*) FILTER (WHERE contype = 'c' AND convalidated AND conname = ANY(ARRAY[
              'workspace_memberships_live_check', 'api_sources_live_check',
              'api_spec_versions_live_check', 'api_operations_live_check',
              'operation_policies_live_check', 'credential_metadata_live_check',
              'connector_actors_live_check', 'connector_tokens_live_check',
              'execution_leases_live_check'
            ]))::int AS "childChecks",
            count(*) FILTER (WHERE contype = 'c' AND convalidated AND conname = 'workspaces_live_marker_check')::int AS "parentChecks",
            count(*) FILTER (WHERE contype = 'u' AND conname = 'workspaces_id_live_unique')::int AS "parentKeys"
          FROM pg_constraint
          WHERE connamespace = current_schema()::regnamespace
        `);
        const guards = guardResult.rows[0];
        if (guards?.foreignKeys !== 9 || guards.childChecks !== 9 ||
            guards.parentChecks !== 1 || guards.parentKeys !== 1) {
          throw new ServiceError(
            "Workspace deletion is unavailable until the database safeguards are installed",
            503,
            "WORKSPACE_DELETE_GUARDS_UNAVAILABLE",
          );
        }
      }

      // Serialize deletion against every execution/import lock for this tenant.
      const apiRows = await tx.execute<{ apiId: string }>(sql`
        SELECT id AS "apiId" FROM api_sources
        WHERE workspace_id = ${workspaceId}
        ORDER BY id
      `);
      for (const api of apiRows.rows) {
        // Do not wait here: an import/execution may hold this advisory lock
        // while its write waits for our workspace row lock. Retrying later
        // avoids a lock-order deadlock and never interrupts that request.
        const lock = await tx.execute<{ acquired: boolean }>(sql`
          SELECT pg_try_advisory_xact_lock(hashtext(${`${workspaceId}:${api.apiId}`})) AS acquired
        `);
        if (!lock.rows[0]?.acquired) {
          throw new ServiceError(
            "Workspace has an active execution or import; try again after it completes",
            409,
            "WORKSPACE_DELETE_BUSY",
          );
        }
      }

      const activeLease = await tx.execute(sql`
        SELECT 1 FROM execution_leases
        WHERE workspace_id = ${workspaceId} AND expires_at > now()
        LIMIT 1
      `);
      if (activeLease.rows.length > 0) {
        throw new ServiceError(
          "Workspace has an active execution; try again after it completes",
          409,
          "WORKSPACE_DELETE_BUSY",
        );
      }

      await tx
        .delete(executionLeasesTable)
        .where(eq(executionLeasesTable.workspaceId, workspaceId));
      // Remove guarded children before flipping the workspace live marker.
      // API-source cascades remove specifications, operations, policies, and
      // credentials; actor cascades remove connector tokens.
      await tx.delete(connectorActorsTable).where(eq(connectorActorsTable.workspaceId, workspaceId));
      await tx.delete(apiSourcesTable).where(eq(apiSourcesTable.workspaceId, workspaceId));
      await tx.delete(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.workspaceId, workspaceId));
      await tx
        .update(workspacesTable)
        .set({ deletedAt: new Date(), isLive: false })
        .where(eq(workspacesTable.id, workspaceId));
      // Security events intentionally retain their historical actor identifier:
      // the table has no actor FK, so this does not retain active tenant data.
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: "workspace.deleted",
        resourceType: "workspace",
        resourceId: workspaceId,
        metadata: { name: workspace.name, deletedBy: userId },
      });
    });
  }
}
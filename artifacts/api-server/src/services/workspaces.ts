import { and, count, desc, eq } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  auditEventsTable,
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
      .where(eq(workspaceMembershipsTable.userId, userId))
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
      .where(and(eq(workspacesTable.id, workspaceId), eq(workspaceMembershipsTable.userId, userId)))
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
}
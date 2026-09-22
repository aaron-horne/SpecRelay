import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  type SQL,
} from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  auditEventsTable,
  db,
  workspacesTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import { ServiceError } from "./errors";

const OUTCOME_EVENTS = {
  ATTEMPTED: ["execution.attempted"],
  SUCCESS: ["execution.succeeded"],
  DENIED: ["execution.denied"],
  ERROR: [
    "execution.credential_rejected",
    "execution.failed",
    "execution.response_limit_exceeded",
    "execution.timed_out",
    "execution.upstream_http_error",
  ],
} as const;

const EXECUTION_EVENTS = Object.values(OUTCOME_EVENTS).flat();

type ExecutionOutcome = keyof typeof OUTCOME_EVENTS;

type ListExecutionLogsInput = {
  page: number;
  pageSize: number;
  workspaceId?: string;
  outcome?: ExecutionOutcome;
  search?: string;
};

function outcomeFor(eventType: string): ExecutionOutcome {
  if (eventType === "execution.attempted") return "ATTEMPTED";
  if (eventType === "execution.succeeded") return "SUCCESS";
  if (eventType === "execution.denied") return "DENIED";
  return "ERROR";
}

function safeUpstreamStatus(metadata: Record<string, unknown>): number | null {
  const status = metadata.status;
  return Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
    ? Number(status)
    : null;
}

function literalSearchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export class ExecutionLogsService {
  async list(userId: string, input: ListExecutionLogsInput) {
    if (input.workspaceId) {
      const [membership] = await db
        .select({ workspaceId: workspaceMembershipsTable.workspaceId })
        .from(workspaceMembershipsTable)
        .where(and(
          eq(workspaceMembershipsTable.workspaceId, input.workspaceId),
          eq(workspaceMembershipsTable.userId, userId),
        ))
        .limit(1);
      if (!membership) {
        throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
      }
    }

    const conditions: SQL[] = [
      eq(workspaceMembershipsTable.userId, userId),
      inArray(auditEventsTable.eventType, EXECUTION_EVENTS),
    ];
    if (input.workspaceId) {
      conditions.push(eq(auditEventsTable.workspaceId, input.workspaceId));
    }
    if (input.outcome) {
      conditions.push(inArray(auditEventsTable.eventType, OUTCOME_EVENTS[input.outcome]));
    }
    const search = input.search?.trim();
    if (search) {
      const pattern = literalSearchPattern(search);
      conditions.push(or(
        ilike(workspacesTable.name, pattern),
        ilike(apiSourcesTable.name, pattern),
        ilike(apiOperationsTable.displayName, pattern),
        ilike(apiOperationsTable.operationId, pattern),
        ilike(apiOperationsTable.method, pattern),
        ilike(apiOperationsTable.path, pattern),
        ilike(auditEventsTable.eventType, pattern),
      )!);
    }

    const where = and(...conditions);
    const joins = (query: any) => query
      .innerJoin(
        workspaceMembershipsTable,
        and(
          eq(workspaceMembershipsTable.workspaceId, auditEventsTable.workspaceId),
          eq(workspaceMembershipsTable.userId, userId),
        ),
      )
      .innerJoin(workspacesTable, eq(workspacesTable.id, auditEventsTable.workspaceId))
      .leftJoin(
        apiOperationsTable,
        and(
          eq(auditEventsTable.resourceType, "api_operation"),
          eq(apiOperationsTable.workspaceId, auditEventsTable.workspaceId),
          eq(apiOperationsTable.id, auditEventsTable.resourceId),
        ),
      )
      .leftJoin(
        apiSourcesTable,
        and(
          eq(apiSourcesTable.workspaceId, auditEventsTable.workspaceId),
          eq(apiSourcesTable.id, apiOperationsTable.apiId),
        ),
      );

    const [rows, totalRows] = await Promise.all([
      joins(db
        .select({
          id: auditEventsTable.id,
          createdAt: auditEventsTable.createdAt,
          workspaceId: auditEventsTable.workspaceId,
          workspaceName: workspacesTable.name,
          apiId: apiSourcesTable.id,
          apiName: apiSourcesTable.name,
          operationId: apiOperationsTable.id,
          toolName: apiOperationsTable.operationId,
          operationDisplayName: apiOperationsTable.displayName,
          method: apiOperationsTable.method,
          path: apiOperationsTable.path,
          eventType: auditEventsTable.eventType,
          metadata: auditEventsTable.metadata,
        })
        .from(auditEventsTable))
        .where(where)
        .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize),
      joins(db
        .select({ value: count() })
        .from(auditEventsTable))
        .where(where),
    ]);

    const total = totalRows[0]?.value ?? 0;
    return {
      items: rows.map((row: typeof rows[number]) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        apiId: row.apiId,
        apiName: row.apiName,
        operationId: row.operationId,
        toolName: row.toolName ?? row.operationDisplayName,
        method: row.method,
        path: row.path,
        eventType: row.eventType,
        outcome: outcomeFor(row.eventType),
        upstreamStatus: safeUpstreamStatus(row.metadata),
      })),
      page: input.page,
      pageSize: input.pageSize,
      total,
      totalPages: Math.ceil(total / input.pageSize),
    };
  }
}
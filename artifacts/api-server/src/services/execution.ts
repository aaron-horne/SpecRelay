import { and, desc, eq } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSpecVersionsTable,
  db,
  pool,
  operationPoliciesTable,
  type PoolClient,
  workspaceMembershipsTable,
} from "@workspace/db";
import {
  createMcpTool,
  mcpToolName,
  type McpToolDescriptor,
} from "@workspace/mcp";
import {
  OutboundBrokerError,
  type OutboundRequestBroker,
} from "@workspace/security";
import { ServiceError } from "./errors";
import { isExecutableServer, isMcpListableOperation } from "./mcp-listing-eligibility";
import { authenticationMode, operationView, securityGroupsFor } from "./mcp-operation-view";
import { publishedMcpDescriptions } from "./semantic-mcp-publication";
import { securityServices } from "./security";

const LEASE_DURATION_MS = 30_000;
const lockKey = (workspaceId: string, apiId: string) => `${workspaceId}:${apiId}`;
type LeaseClient = PoolClient;

type ToolArguments = Readonly<Record<string, unknown>>;

function applyArguments(
  serverUrl: string,
  pathTemplate: string,
  parameters: typeof apiOperationsTable.$inferSelect.parameters,
  args: ToolArguments,
  managedQueryNames: ReadonlySet<string> = new Set(),
): URL {
  const declared = new Set(parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(args)) {
    if (!declared.has(name)) {
      throw new ServiceError(`Unknown tool argument: ${name}`, 400, "INVALID_TOOL_ARGUMENT");
    }
    if (managedQueryNames.has(name.toLowerCase())) {
      throw new ServiceError("Managed authentication parameters cannot be supplied", 400, "PROTECTED_PARAMETER");
    }
  }
  let path = pathTemplate;
  const query = new URLSearchParams();
  for (const parameter of parameters) {
    if (parameter.location !== "path" && parameter.location !== "query") {
      throw new ServiceError("Only path and query parameters are supported", 400, "UNSUPPORTED_PARAMETER");
    }
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) {
        throw new ServiceError(`Missing required argument: ${parameter.name}`, 400, "MISSING_TOOL_ARGUMENT");
      }
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new ServiceError(`Invalid argument: ${parameter.name}`, 400, "INVALID_TOOL_ARGUMENT");
    }
    const encoded = encodeURIComponent(String(value));
    if (parameter.location === "path") {
      path = path.replaceAll(`{${parameter.name}}`, encoded);
    } else {
      query.append(parameter.name, String(value));
    }
  }
  if (/{[^}]+}/.test(path)) {
    throw new ServiceError("Unresolved path parameter", 400, "MISSING_TOOL_ARGUMENT");
  }
  const base = new URL(serverUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new ServiceError("Specification server must be unauthenticated HTTPS", 400, "UNSUPPORTED_SERVER");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  base.search = query.toString();
  base.hash = "";
  return base;
}

export class ExecutionService {
  constructor(private readonly broker?: OutboundRequestBroker) {}

  private async acquireLease(
    workspaceId: string,
    operation: typeof apiOperationsTable.$inferSelect,
  ) {
    const client = await pool.connect();
    let locked = false;
    let inTransaction = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock_shared(hashtext($1)) AS acquired",
        [lockKey(workspaceId, operation.apiId)],
      );
      if (!lock.rows[0]?.acquired) {
        throw new ServiceError(
          "Execution lease could not be acquired",
          409,
          "EXECUTION_LEASE_UNAVAILABLE",
        );
      }
      locked = true;
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "DELETE FROM execution_leases WHERE workspace_id = $1 AND api_id = $2 AND expires_at <= now()",
        [workspaceId, operation.apiId],
      );
      const latest = await client.query<{ id: string }>(
        "SELECT id FROM api_spec_versions WHERE workspace_id = $1 AND api_id = $2 AND is_active = true LIMIT 1",
        [workspaceId, operation.apiId],
      );
      if (latest.rows[0]?.id !== operation.specificationId) {
        await client.query("ROLLBACK");
        inTransaction = false;
        throw new ServiceError(
          "Operation is not from the latest specification",
          403,
          "EXECUTION_DENIED",
        );
      }
      const lease = await client.query<{ id: string }>(
        "INSERT INTO execution_leases (workspace_id, api_id, specification_id, operation_id, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond')) RETURNING id",
        [workspaceId, operation.apiId, operation.specificationId, operation.id, LEASE_DURATION_MS],
      );
      if (!lease.rows[0]) {
        await client.query("ROLLBACK");
        inTransaction = false;
        throw new ServiceError("Execution lease could not be acquired", 409, "EXECUTION_LEASE_UNAVAILABLE");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return { leaseId: lease.rows[0].id, client };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The client is still released below; preserve the original failure.
        }
      }
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [lockKey(workspaceId, operation.apiId)]);
        } catch {
          // Releasing the client also releases session advisory locks.
        }
      }
      client.release();
      throw error;
    }
  }

  private async releaseLease(
    leaseId: string,
    client: LeaseClient,
    workspaceId: string,
    apiId: string,
  ): Promise<void> {
    try {
      await client.query("DELETE FROM execution_leases WHERE id = $1", [leaseId]);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [lockKey(workspaceId, apiId)]);
      } finally {
        client.release();
      }
    }
  }

  private async authorizedOperation(workspaceId: string, actorId: string, operationId: string) {
    const [row] = await db
      .select({
        operation: apiOperationsTable,
        serverUrls: apiSpecVersionsTable.serverUrls,
        securitySchemes: apiSpecVersionsTable.securitySchemes,
        decision: operationPoliciesTable.decision,
        approved: operationPoliciesTable.executionApproved,
      })
      .from(apiOperationsTable)
      .innerJoin(
        apiSpecVersionsTable,
        and(
          eq(apiSpecVersionsTable.workspaceId, apiOperationsTable.workspaceId),
          eq(apiSpecVersionsTable.apiId, apiOperationsTable.apiId),
          eq(apiSpecVersionsTable.id, apiOperationsTable.specificationId),
        ),
      )
      .innerJoin(
        operationPoliciesTable,
        and(
          eq(operationPoliciesTable.workspaceId, apiOperationsTable.workspaceId),
          eq(operationPoliciesTable.operationId, apiOperationsTable.id),
        ),
      )
      .innerJoin(
        workspaceMembershipsTable,
        and(
          eq(workspaceMembershipsTable.workspaceId, apiOperationsTable.workspaceId),
          eq(workspaceMembershipsTable.userId, actorId),
        ),
      )
      .where(and(
        eq(apiOperationsTable.workspaceId, workspaceId),
        eq(apiOperationsTable.id, operationId),
        eq(apiSpecVersionsTable.isActive, true),
      ))
      .limit(1);
    if (!row) throw new ServiceError("Operation not found", 404, "OPERATION_NOT_FOUND");
    return row;
  }

  async execute(workspaceId: string, actorId: string, operationId: string, args: ToolArguments, authorizeDispatch?: () => Promise<boolean>) {
    const row = await this.authorizedOperation(workspaceId, actorId, operationId);
    const operation = row.operation;
    const audit = securityServices.auditService;
    await audit.record({
      workspaceId, actorId, eventType: "execution.attempted",
      resourceType: "api_operation", resourceId: operation.id,
      metadata: { actorId, method: operation.method, path: operation.path },
    });

    if (
      !operation.enabled || !row.approved || row.decision !== "ALLOW" ||
      operation.method.toUpperCase() !== "GET" || operation.requestBody ||
      row.serverUrls.length === 0
    ) {
      await audit.record({
        workspaceId, actorId, eventType: "execution.denied",
        resourceType: "api_operation", resourceId: operation.id,
         metadata: { actorId, reason: "Operation is not approved for HTTPS GET execution" },
      });
      throw new ServiceError("Operation is not approved for execution", 403, "EXECUTION_DENIED");
    }

    let destination: URL;
    try {
      const managedQueryNames = new Set(
        row.securitySchemes
          .filter((scheme) => scheme.type === "apiKey" && scheme.location === "query" && scheme.parameterName)
          .map((scheme) => scheme.parameterName!.toLowerCase()),
      );
      destination = applyArguments(
        row.serverUrls[0]!,
        operation.path,
        operation.parameters,
        args,
        managedQueryNames,
      );
    } catch (error) {
      await audit.record({
        workspaceId, actorId, eventType: "execution.failed",
        resourceType: "api_operation", resourceId: operation.id,
        metadata: {
          actorId,
          code: error instanceof ServiceError ? error.code : "INVALID_DESTINATION",
        },
      });
      throw error;
    }
    // Re-check immediately before dispatch. Imports are committed independently,
    // so an operation selected from an older MCP listing must fail closed.
    const [currentSpec] = await db
      .select({ id: apiSpecVersionsTable.id })
      .from(apiSpecVersionsTable)
      .where(and(
        eq(apiSpecVersionsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.apiId, operation.apiId),
        eq(apiSpecVersionsTable.isActive, true),
      ))
      .orderBy(desc(apiSpecVersionsTable.importedAt), desc(apiSpecVersionsTable.id))
      .limit(1);
    if (!currentSpec || currentSpec.id !== operation.specificationId) {
      await audit.record({
        workspaceId, actorId, eventType: "execution.denied",
        resourceType: "api_operation", resourceId: operation.id,
        metadata: { actorId, reason: "Operation is not from the latest specification" },
      });
      throw new ServiceError("Operation is not from the latest specification", 403, "EXECUTION_DENIED");
    }
    let lease: { leaseId: string; client: LeaseClient } | undefined;
    try {
      lease = await this.acquireLease(workspaceId, operation);
      // Revocation cannot recall a call already dispatched, but always blocks new dispatches.
      if (authorizeDispatch && !(await authorizeDispatch())) {
        throw new ServiceError("Connector no longer authorized", 403, "EXECUTION_DENIED");
      }
      const response = await (this.broker ?? securityServices.outboundRequestBroker).execute({
        workspaceId,
        actorId,
        apiSourceId: operation.apiId,
        operationId: operation.id,
        operation: {
          method: operation.method, path: operation.path, operationId: operation.operationId,
          displayName: operation.displayName, summary: operation.summary,
          description: operation.description, tags: operation.tags,
          parameters: operation.parameters, requestBody: operation.requestBody,
          responses: operation.responses,
           securityRequirements: operation.securityRequirements.map((scheme) => ({ scheme, scopes: [] })),
           securityGroups: securityGroupsFor(operation),
          risk: operation.risk,
        },
         securitySchemes: row.securitySchemes,
        destination,
        method: "GET",
        headers: { accept: "application/json, text/plain;q=0.9" },
        timeoutMs: 5_000,
        maxResponseBytes: 1_048_576,
      });
      const completedWithHttpError = response.status >= 400;
      const executionGroups = securityGroupsFor(operation);
      const requiresCredential = executionGroups.length > 0 &&
        !executionGroups.some((group) => group.length === 0);
      if (requiresCredential && (response.status === 401 || response.status === 403)) {
        await audit.record({
          workspaceId,
          actorId,
          eventType: "execution.credential_rejected",
          resourceType: "api_operation",
          resourceId: operation.id,
          metadata: { actorId, status: response.status, destinationHost: destination.hostname },
        });
        throw new ServiceError("Upstream rejected the configured credential", 502, "CREDENTIAL_REJECTED");
      }
      await audit.record({
        workspaceId,
        actorId,
        eventType: completedWithHttpError ? "execution.upstream_http_error" : "execution.succeeded",
        resourceType: "api_operation", resourceId: operation.id,
        metadata: {
          actorId,
          status: response.status,
          responseBytes: response.body.byteLength,
          destinationHost: destination.hostname,
        },
      });
      return {
        status: response.status,
        headers: response.headers,
        body: new TextDecoder().decode(response.body),
      };
    } catch (error) {
      const code =
        error instanceof OutboundBrokerError || error instanceof ServiceError
          ? error.code
          : "UPSTREAM_FAILURE";
      const eventType =
        code === "TIMEOUT" ? "execution.timed_out" :
        code === "RESPONSE_LIMIT" ? "execution.response_limit_exceeded" :
        code === "VALIDATION_DENIED" || code === "REDIRECT_BLOCKED" ||
        code === "CREDENTIAL_UNAVAILABLE" || code === "UPSTREAM_SECRET_REFLECTION" ||
        code === "EXECUTION_DENIED" || code === "EXECUTION_LEASE_UNAVAILABLE" ? "execution.denied" :
        "execution.failed";
      await audit.record({
        workspaceId, actorId, eventType,
        resourceType: "api_operation", resourceId: operation.id,
        metadata: { actorId, code, destinationHost: destination.hostname },
      });
      if (error instanceof OutboundBrokerError) {
        throw new ServiceError(
          error.message,
          code === "TIMEOUT" ? 504 : code === "CREDENTIAL_UNAVAILABLE" ? 403 : 502,
          code,
        );
      }
      throw error;
    } finally {
      if (lease) await this.releaseLease(lease.leaseId, lease.client, workspaceId, operation.apiId);
    }
  }
}

export class McpService {
  constructor(private readonly execution = new ExecutionService()) {}

  async listTools(workspaceId: string, actorId: string): Promise<McpToolDescriptor[]> {
    const rows = await db
      .select({
        operation: apiOperationsTable,
        importedAt: apiSpecVersionsTable.importedAt,
        documentHash: apiSpecVersionsTable.documentHash,
        serverUrls: apiSpecVersionsTable.serverUrls,
        securitySchemes: apiSpecVersionsTable.securitySchemes,
        decision: operationPoliciesTable.decision,
        approved: operationPoliciesTable.executionApproved,
      })
      .from(apiOperationsTable)
      .innerJoin(apiSpecVersionsTable, eq(apiSpecVersionsTable.id, apiOperationsTable.specificationId))
      .innerJoin(operationPoliciesTable, and(
        eq(operationPoliciesTable.workspaceId, apiOperationsTable.workspaceId),
        eq(operationPoliciesTable.operationId, apiOperationsTable.id),
      ))
      .innerJoin(workspaceMembershipsTable, and(
        eq(workspaceMembershipsTable.workspaceId, apiOperationsTable.workspaceId),
        eq(workspaceMembershipsTable.userId, actorId),
      ))
      .where(and(
        eq(apiOperationsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.isActive, true),
      ))
      .orderBy(desc(apiSpecVersionsTable.importedAt));
    const latestSpecByApi = new Map<string, string>();
    const currentRows: typeof rows = [];
    for (const row of rows) {
      const latest = latestSpecByApi.get(row.operation.apiId);
      if (!latest) latestSpecByApi.set(row.operation.apiId, row.operation.specificationId);
      if (latestSpecByApi.get(row.operation.apiId) === row.operation.specificationId) currentRows.push(row);
    }
    const eligibleOperations: Array<{
      operation: typeof apiOperationsTable.$inferSelect;
      documentHash: string;
      securitySchemes: typeof apiSpecVersionsTable.$inferSelect.securitySchemes;
    }> = [];
    for (const { operation, documentHash, serverUrls, securitySchemes, approved, decision } of currentRows) {
      if (!(await isMcpListableOperation(workspaceId, {
        operation, serverUrls, securitySchemes, approved, decision,
      }))) continue;
      eligibleOperations.push({ operation, documentHash, securitySchemes });
    }
    const descriptions = await publishedMcpDescriptions(workspaceId, eligibleOperations);
    return eligibleOperations.map(({ operation, securitySchemes }) => {
      const view = operationView(operation, authenticationMode(operation, securitySchemes));
      return createMcpTool({
        ...view,
        description: descriptions.get(operation.id) ?? view.description,
      });
    });
  }

  async callTool(workspaceId: string, actorId: string, name: string, args: ToolArguments, authorizeDispatch?: () => Promise<boolean>) {
    const rows = await db.select({
      operation: apiOperationsTable,
      importedAt: apiSpecVersionsTable.importedAt,
      serverUrls: apiSpecVersionsTable.serverUrls,
    }).from(apiOperationsTable)
      .innerJoin(apiSpecVersionsTable, eq(apiSpecVersionsTable.id, apiOperationsTable.specificationId))
      .innerJoin(workspaceMembershipsTable, and(
        eq(workspaceMembershipsTable.workspaceId, apiOperationsTable.workspaceId),
        eq(workspaceMembershipsTable.userId, actorId),
      ))
      .where(and(
        eq(apiOperationsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.isActive, true),
      ))
      .orderBy(desc(apiSpecVersionsTable.importedAt));
    const latestSpecByApi = new Map<string, string>();
    const matching = rows.find((row) => {
      if (!latestSpecByApi.has(row.operation.apiId)) {
        latestSpecByApi.set(row.operation.apiId, row.operation.specificationId);
      }
      return latestSpecByApi.get(row.operation.apiId) === row.operation.specificationId &&
        isExecutableServer(row.serverUrls[0]) &&
        mcpToolName(operationView(row.operation)) === name;
    })?.operation;
    if (!matching) throw new ServiceError("MCP tool not found", 404, "MCP_TOOL_NOT_FOUND");
    return this.execution.execute(workspaceId, actorId, matching.id, args, authorizeDispatch);
  }
}
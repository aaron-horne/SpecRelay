import { and, eq, isNull, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  executionLeasesTable,
  operationPoliciesTable,
  semanticAnalysisProposalsTable,
  workspacesTable,
  type ApiSourceRow,
  type ApiSpecVersionRow,
  workspaceMembershipsTable,
} from "@workspace/db";
import {
  hashOpenApiDocument,
  SecureOpenApiAdapter,
} from "@workspace/openapi";
import { ServiceError } from "./errors";
import { mapApiSource, mapOperation, mapSpecification } from "./mappers";
import { staleMcpPublications } from "./semantic-mcp-publication";

const adapter = new SecureOpenApiAdapter();

async function latestSpecification(
  workspaceId: string,
  apiId: string,
): Promise<ApiSpecVersionRow | null> {
  const [row] = await db
    .select()
    .from(apiSpecVersionsTable)
    .where(and(
      eq(apiSpecVersionsTable.workspaceId, workspaceId),
      eq(apiSpecVersionsTable.apiId, apiId),
      eq(apiSpecVersionsTable.isActive, true),
    ))
    .limit(1);
  return row ?? null;
}

export class CatalogService {
  private async requireWorkspace(workspaceId: string): Promise<void> {
    const [workspace] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(and(eq(workspacesTable.id, workspaceId), isNull(workspacesTable.deletedAt)))
      .limit(1);
    if (!workspace) {
      throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
    }
  }

  private async requireApi(
    workspaceId: string,
    apiId: string,
  ): Promise<ApiSourceRow> {
    const [api] = await db
      .select()
      .from(apiSourcesTable)
      .where(
        and(
          eq(apiSourcesTable.workspaceId, workspaceId),
          eq(apiSourcesTable.id, apiId),
        ),
      )
      .limit(1);
    if (!api) {
      throw new ServiceError("API source not found", 404, "API_NOT_FOUND");
    }
    return api;
  }

  async listApis(workspaceId: string) {
    await this.requireWorkspace(workspaceId);
    const rows = await db
      .select()
      .from(apiSourcesTable)
      .where(eq(apiSourcesTable.workspaceId, workspaceId))
      .orderBy(apiSourcesTable.createdAt);
    return Promise.all(
      rows.map(async (row) =>
        mapApiSource(row, await latestSpecification(workspaceId, row.id)),
      ),
    );
  }

  async createApi(
    workspaceId: string,
    input: { name: string; description?: string | null },
  ) {
    await this.requireWorkspace(workspaceId);
    return db.transaction(async (tx) => {
      const [api] = await tx
        .insert(apiSourcesTable)
        .values({
          workspaceId,
          name: input.name,
          description: input.description ?? null,
        })
        .returning();
      if (!api) {
        throw new ServiceError(
          "API source could not be created",
          400,
          "API_CREATE_FAILED",
        );
      }
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: "api.created",
        resourceType: "api_source",
        resourceId: api.id,
        metadata: { name: api.name },
      });
      return mapApiSource(api, null);
    });
  }

  async getApi(workspaceId: string, apiId: string, actorId?: string) {
    const api = await this.requireApi(workspaceId, apiId);
    const specification = await latestSpecification(workspaceId, apiId);
    const operations = await this.listOperations(workspaceId, apiId);
    let canManage = false;
    if (actorId) {
      const [membership] = await db
        .select({ role: workspaceMembershipsTable.role })
        .from(workspaceMembershipsTable)
        .where(and(
          eq(workspaceMembershipsTable.workspaceId, workspaceId),
          eq(workspaceMembershipsTable.userId, actorId),
        ))
        .limit(1);
      canManage = membership?.role === "OWNER";
    }
    return {
      api: mapApiSource(api, specification),
      operations,
      canManage,
    };
  }

  async importSpecification(
    workspaceId: string,
    apiId: string,
    document: string,
    actorId = "system:import",
  ) {
    await this.requireApi(workspaceId, apiId);
    const parsed = adapter.parseAndNormalize(document);
    const documentHash = hashOpenApiDocument(document);

    const [existing] = await db
      .select()
      .from(apiSpecVersionsTable)
      .where(
        and(
          eq(apiSpecVersionsTable.workspaceId, workspaceId),
          eq(apiSpecVersionsTable.apiId, apiId),
          eq(apiSpecVersionsTable.documentHash, documentHash),
        ),
      )
      .limit(1);

    if (existing) {
      const operations = await db
        .select()
        .from(apiOperationsTable)
        .where(
          and(
            eq(apiOperationsTable.workspaceId, workspaceId),
            eq(apiOperationsTable.apiId, apiId),
            eq(apiOperationsTable.specificationId, existing.id),
          ),
        )
        .orderBy(apiOperationsTable.path, apiOperationsTable.method);
      return {
        specification: mapSpecification(existing),
        operations: operations.map(mapOperation),
        validation: {
          valid: true,
          warnings: existing.validationWarnings,
          unsupported: parsed.definition.unsupported,
        },
      };
    }

    return db.transaction(async (tx) => {
      // Imports and execution lease acquisition use the same transaction-level
      // lock, preventing a replacement from racing an outbound dispatch.
      const lockResult = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`${workspaceId}:${apiId}`})) AS acquired`);
      if (!(lockResult as unknown as { rows?: Array<{ acquired: boolean }> }).rows?.[0]?.acquired) {
        throw new ServiceError(
          "Specification cannot be replaced while an execution is in progress",
          409,
          "SPECIFICATION_IMPORT_BUSY",
        );
      }
      await tx.delete(executionLeasesTable).where(and(
        eq(executionLeasesTable.workspaceId, workspaceId),
        eq(executionLeasesTable.apiId, apiId),
        sql`${executionLeasesTable.expiresAt} <= now()`,
      ));
      // Re-check under the lock so concurrent imports of the same document
      // remain idempotent, including while an execution lease is active.
      const [lockedExisting] = await tx
        .select()
        .from(apiSpecVersionsTable)
        .where(and(
          eq(apiSpecVersionsTable.workspaceId, workspaceId),
          eq(apiSpecVersionsTable.apiId, apiId),
          eq(apiSpecVersionsTable.documentHash, documentHash),
        ))
        .limit(1);
      if (lockedExisting) {
        const operations = await tx
          .select()
          .from(apiOperationsTable)
          .where(and(
            eq(apiOperationsTable.workspaceId, workspaceId),
            eq(apiOperationsTable.apiId, apiId),
            eq(apiOperationsTable.specificationId, lockedExisting.id),
          ))
          .orderBy(apiOperationsTable.path, apiOperationsTable.method);
        return {
          specification: mapSpecification(lockedExisting),
          operations: operations.map(mapOperation),
          validation: {
            valid: true,
            warnings: lockedExisting.validationWarnings,
            unsupported: parsed.definition.unsupported,
          },
        };
      }
      const [activeLease] = await tx
        .select({ id: executionLeasesTable.id })
        .from(executionLeasesTable)
        .where(and(
          eq(executionLeasesTable.workspaceId, workspaceId),
          eq(executionLeasesTable.apiId, apiId),
          sql`${executionLeasesTable.expiresAt} > now()`,
        ))
        .limit(1);
      if (activeLease) {
        throw new ServiceError(
          "Specification cannot be replaced while an execution is in progress",
          409,
          "SPECIFICATION_IMPORT_BUSY",
        );
      }
      await tx
        .update(apiSpecVersionsTable)
        .set({ isActive: false })
        .where(and(
          eq(apiSpecVersionsTable.workspaceId, workspaceId),
          eq(apiSpecVersionsTable.apiId, apiId),
          eq(apiSpecVersionsTable.isActive, true),
        ));
      const [insertedSpecification] = await tx
        .insert(apiSpecVersionsTable)
        .values({
          workspaceId,
          apiId,
          version: parsed.definition.version,
          format: parsed.format,
          openapiVersion: parsed.definition.openapiVersion,
          documentHash,
          rawDocument: document,
          normalizedDocument: parsed.normalizedDocument,
          serverUrls: parsed.definition.servers.map((server) => server.url),
          securitySchemes: parsed.definition.securitySchemes.map((scheme) => ({
            ...scheme,
          })),
          validationWarnings: [...parsed.definition.warnings],
          isActive: true,
        })
        .returning();
      const specification = insertedSpecification;

      if (!specification) {
        throw new ServiceError(
          "Specification could not be imported",
          400,
          "SPECIFICATION_IMPORT_FAILED",
        );
      }

      await staleMcpPublications(tx, workspaceId, actorId, "specification_reimported", apiId);
      const staleProposals = await tx
        .update(semanticAnalysisProposalsTable)
        .set({ status: "stale", decidedAt: new Date() })
        .where(and(
          eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
          eq(semanticAnalysisProposalsTable.apiId, apiId),
          sql`${semanticAnalysisProposalsTable.specificationId} <> ${specification.id}`,
          sql`${semanticAnalysisProposalsTable.status} <> 'stale'`,
        ))
        .returning({
          id: semanticAnalysisProposalsTable.id,
          specificationId: semanticAnalysisProposalsTable.specificationId,
          operationId: semanticAnalysisProposalsTable.operationId,
        });
      if (staleProposals.length) {
        await tx.insert(auditEventsTable).values(staleProposals.map((proposal) => ({
          workspaceId,
          eventType: "semantic_analysis.proposal_stale",
          resourceType: "semantic_analysis_proposal",
          resourceId: proposal.id,
          metadata: {
            apiId,
            specificationId: proposal.specificationId,
            operationId: proposal.operationId,
            reason: "specification_reimported",
          },
        })));
      }

      const operationRows =
        parsed.definition.operations.length === 0
          ? []
          : await tx
              .insert(apiOperationsTable)
              .values(
                parsed.definition.operations.map((operation) => ({
                  workspaceId,
                  apiId,
                  specificationId: specification.id,
                  method: operation.method,
                  path: operation.path,
                  operationId: operation.operationId,
                  displayName: operation.displayName,
                  summary: operation.summary,
                  description: operation.description,
                  tags: [...operation.tags],
                  parameters: operation.parameters.map((parameter) => ({
                    ...parameter,
                  })),
                  requestBody: operation.requestBody
                    ? {
                        ...operation.requestBody,
                        contentTypes: [...operation.requestBody.contentTypes],
                      }
                    : null,
                  responses: operation.responses.map((response) => ({
                    ...response,
                    contentTypes: [...response.contentTypes],
                  })),
                  securityRequirements: operation.securityRequirements.map(
                    (requirement) =>
                      requirement.scopes.length > 0
                        ? `${requirement.scheme}:${requirement.scopes.join(",")}`
                        : requirement.scheme,
                  ),
                  securityGroups: (operation.securityGroups ?? []).map((group) =>
                    group.map((requirement) => ({
                      scheme: requirement.scheme,
                      scopes: [...requirement.scopes],
                    })),
                  ),
                  risk: operation.risk,
                  enabled: false,
                })),
              )
              .returning();

      if (operationRows.length > 0) {
        await tx.insert(operationPoliciesTable).values(
          operationRows.map((operation) => ({
            workspaceId,
            operationId: operation.id,
            decision: "DENY" as const,
          })),
        );
      }

      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: "specification.imported",
        resourceType: "api_spec_version",
        resourceId: specification.id,
        metadata: {
          apiId,
          documentHash,
          operationCount: operationRows.length,
          openapiVersion: parsed.definition.openapiVersion,
        },
      });

      return {
        specification: mapSpecification(specification),
        operations: operationRows.map(mapOperation),
        validation: {
          valid: true,
          warnings: [...parsed.definition.warnings],
          unsupported: [...parsed.definition.unsupported],
        },
      };
    });
  }

  async listOperations(workspaceId: string, apiId: string) {
    await this.requireApi(workspaceId, apiId);
    const specification = await latestSpecification(workspaceId, apiId);
    if (!specification) {
      return [];
    }
    const rows = await db
      .select()
      .from(apiOperationsTable)
      .where(
        and(
          eq(apiOperationsTable.workspaceId, workspaceId),
          eq(apiOperationsTable.apiId, apiId),
          eq(apiOperationsTable.specificationId, specification.id),
        ),
      )
      .orderBy(apiOperationsTable.path, apiOperationsTable.method);
    return rows.map(mapOperation);
  }

  async getOperation(
    workspaceId: string,
    apiId: string,
    operationId: string,
  ) {
    const specification = await latestSpecification(workspaceId, apiId);
    if (!specification) {
      throw new ServiceError(
        "Operation not found",
        404,
        "OPERATION_NOT_FOUND",
      );
    }
    const [operation] = await db
      .select()
      .from(apiOperationsTable)
      .where(
        and(
          eq(apiOperationsTable.workspaceId, workspaceId),
          eq(apiOperationsTable.apiId, apiId),
          eq(apiOperationsTable.specificationId, specification.id),
          eq(apiOperationsTable.id, operationId),
        ),
      )
      .limit(1);
    if (!operation) {
      throw new ServiceError(
        "Operation not found",
        404,
        "OPERATION_NOT_FOUND",
      );
    }
    return mapOperation(operation);
  }

  async updateOperationState(
    workspaceId: string,
    apiId: string,
    operationId: string,
    enabled: boolean,
    actorId: string,
  ) {
    const specification = await latestSpecification(workspaceId, apiId);
    if (!specification) {
      throw new ServiceError(
        "Operation not found",
        404,
        "OPERATION_NOT_FOUND",
      );
    }
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .update(apiOperationsTable)
        .set({ enabled, updatedAt: new Date() })
        .where(
          and(
            eq(apiOperationsTable.workspaceId, workspaceId),
            eq(apiOperationsTable.apiId, apiId),
            eq(apiOperationsTable.specificationId, specification.id),
            eq(apiOperationsTable.id, operationId),
          ),
        )
        .returning();
      if (!operation) {
        throw new ServiceError(
          "Operation not found",
          404,
          "OPERATION_NOT_FOUND",
        );
      }

      await tx
        .update(operationPoliciesTable)
        .set({
          decision: enabled ? "ALLOW" : "DENY",
          executionApproved: enabled,
          approvedBy: enabled ? actorId : null,
          approvedAt: enabled ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(operationPoliciesTable.workspaceId, workspaceId),
            eq(operationPoliciesTable.operationId, operation.id),
          ),
        );

      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: enabled ? "operation.enabled" : "operation.disabled",
        resourceType: "api_operation",
        resourceId: operation.id,
        metadata: {
          apiId,
          method: operation.method,
          path: operation.path,
          risk: operation.risk,
          decision: enabled ? "ALLOW" : "DENY",
          approvedBy: enabled ? actorId : null,
        },
      });

      return mapOperation(operation);
    });
  }
}
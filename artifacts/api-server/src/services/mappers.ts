import type {
  ApiOperationRow,
  ApiSourceRow,
  ApiSpecVersionRow,
  AuditEventRow,
} from "@workspace/db";

export function mapSpecification(row: ApiSpecVersionRow) {
  return {
    id: row.id,
    apiId: row.apiId,
    version: row.version,
    format: row.format,
    openapiVersion: row.openapiVersion,
    documentHash: row.documentHash,
    serverUrls: row.serverUrls,
    securitySchemes: row.securitySchemes,
    validationWarnings: row.validationWarnings,
    importedAt: row.importedAt,
  };
}

export function mapApiSource(
  row: ApiSourceRow,
  latestSpecification: ApiSpecVersionRow | null,
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestSpecification: latestSpecification
      ? mapSpecification(latestSpecification)
      : null,
  };
}

export function mapOperation(row: ApiOperationRow) {
  return {
    id: row.id,
    apiId: row.apiId,
    specificationId: row.specificationId,
    method: row.method,
    path: row.path,
    operationId: row.operationId,
    displayName: row.displayName,
    summary: row.summary,
    description: row.description,
    tags: row.tags,
    parameters: row.parameters,
    requestBody: row.requestBody ?? null,
    responses: row.responses,
    securityRequirements: row.securityRequirements,
    securityGroups: row.securityGroups,
    risk: row.risk,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapAuditEvent(row: AuditEventRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    eventType: row.eventType,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}
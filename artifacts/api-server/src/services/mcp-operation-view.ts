import { apiOperationsTable, apiSpecVersionsTable } from "@workspace/db";
import type { McpApprovedOperation } from "@workspace/mcp";

export function operationView(
  row: typeof apiOperationsTable.$inferSelect,
  authentication?: McpApprovedOperation["authentication"],
): McpApprovedOperation {
  return {
    id: row.id,
    operationId: row.operationId,
    displayName: row.displayName,
    description: row.description,
    parameters: row.parameters,
    authentication,
  };
}

export function securityGroupsFor(
  operation: typeof apiOperationsTable.$inferSelect,
): Array<Array<{ scheme: string; scopes: string[] }>> {
  if (operation.securityGroups.length > 0) return operation.securityGroups;
  return operation.securityRequirements.map((scheme) => [{ scheme, scopes: [] }]);
}

export function authenticationMode(
  row: typeof apiOperationsTable.$inferSelect,
  schemes: typeof apiSpecVersionsTable.$inferSelect.securitySchemes,
): McpApprovedOperation["authentication"] {
  const groups = securityGroupsFor(row);
  if (groups.length === 0 || groups.some((group) => group.length === 0)) return "unauthenticated";
  const names = new Set(groups[0]?.map((entry) => entry.scheme));
  if (groups.length === 1 && names.size === 1) {
    const scheme = schemes.find((item) => names.has(item.name));
    if (scheme?.bearer) return "bearer";
  }
  return "api-key";
}
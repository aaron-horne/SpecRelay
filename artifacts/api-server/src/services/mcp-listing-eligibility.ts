import {
  apiOperationsTable,
  apiSpecVersionsTable,
  operationPoliciesTable,
} from "@workspace/db";
import { securityGroupsFor } from "./mcp-operation-view";
import { securityServices } from "./security";

type ListingCandidate = {
  operation: typeof apiOperationsTable.$inferSelect;
  approved: typeof operationPoliciesTable.$inferSelect.executionApproved;
  decision: typeof operationPoliciesTable.$inferSelect.decision;
  serverUrls: typeof apiSpecVersionsTable.$inferSelect.serverUrls;
  securitySchemes: typeof apiSpecVersionsTable.$inferSelect.securitySchemes;
};

export function isExecutableServer(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function destinationHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// The publication guard and tools/list must use the same listing requirements.
export async function isMcpListableOperation(workspaceId: string, {
  operation, approved, decision, serverUrls, securitySchemes,
}: ListingCandidate): Promise<boolean> {
  if (
    !operation.enabled ||
    !approved ||
    decision !== "ALLOW" ||
    operation.method.toUpperCase() !== "GET" ||
    operation.requestBody ||
    !isExecutableServer(serverUrls[0]) ||
    !operation.parameters.every((parameter) => parameter.location === "path" || parameter.location === "query")
  ) return false;

  const groups = securityGroupsFor(operation);
  if (groups.length > 0 && !groups.some((group) => group.length === 0)) {
    const host = destinationHost(serverUrls[0]);
    if (!host || !(await securityServices.credentialProvider.isConfigured({
      workspaceId,
      apiSourceId: operation.apiId,
      destinationHost: host,
      groups,
      schemes: securitySchemes,
    }))) return false;
  }
  return true;
}
import type { ApiOperation } from "@workspace/api-client-react"

type OperationListingFields = Pick<ApiOperation, "enabled" | "method" | "requestBody" | "parameters">

export function localMcpListingBlockers(operation: OperationListingFields): string[] {
  const blockers: string[] = []
  if (!operation.enabled) blockers.push("Enable this operation.")
  if (operation.method.toUpperCase() !== "GET") blockers.push("MCP tools/list only includes GET operations.")
  if (operation.requestBody) blockers.push("Remove the request body from the imported operation.")
  if (operation.parameters.some((parameter) => parameter.location !== "path" && parameter.location !== "query")) {
    blockers.push("Only path and query parameters can be listed.")
  }
  return blockers
}
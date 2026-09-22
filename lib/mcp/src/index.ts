export const MCP_EXECUTION_IMPLEMENTED = true as const;

export interface McpOperationParameter {
  readonly name: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly schemaType: string | null;
  readonly description: string | null;
}

export interface McpApprovedOperation {
  readonly id: string;
  readonly operationId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly parameters: readonly McpOperationParameter[];
  readonly authentication?: "unauthenticated" | "api-key" | "bearer";
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export function mcpToolName(operation: McpApprovedOperation): string {
  const base = (operation.operationId ?? operation.displayName)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "get_operation";
  return `${base}_${operation.id.slice(0, 8)}`;
}

export function createMcpTool(operation: McpApprovedOperation): McpToolDescriptor {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location !== "path" && parameter.location !== "query") continue;
    const type = parameter.schemaType === "integer" || parameter.schemaType === "number"
      ? "number"
      : parameter.schemaType === "boolean"
        ? "boolean"
        : "string";
    properties[parameter.name] = {
      type,
      description: parameter.description ?? `${parameter.location} parameter`,
    };
    if (parameter.required) required.push(parameter.name);
  }
  return {
    name: mcpToolName(operation),
    description: `${operation.description ?? operation.displayName} (${operation.authentication === "unauthenticated" || !operation.authentication
      ? "unauthenticated"
      : operation.authentication === "api-key" ? "credential-backed API key" : "credential-backed Bearer token"})`,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}
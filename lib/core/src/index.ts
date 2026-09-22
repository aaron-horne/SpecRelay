export type RiskClassification =
  | "READ_LIKE"
  | "WRITE"
  | "DESTRUCTIVE"
  | "UNKNOWN";

export type SecurityWarningSeverity = "info" | "warning" | "blocked";

export interface SecurityWarning {
  readonly code: string;
  readonly message: string;
  readonly path: string | null;
  readonly severity: SecurityWarningSeverity;
}

export interface ApiServer {
  readonly url: string;
  readonly description: string | null;
}

export interface ApiParameter {
  readonly name: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly schemaType: string | null;
  readonly description: string | null;
}

export interface ApiRequestBody {
  readonly required: boolean;
  readonly contentTypes: readonly string[];
  readonly description: string | null;
}

export interface ApiResponse {
  readonly statusCode: string;
  readonly description: string | null;
  readonly contentTypes: readonly string[];
}

export interface ApiSecurityRequirement {
  readonly scheme: string;
  readonly scopes: readonly string[];
}

export interface ApiSecurityScheme {
  readonly name: string;
  readonly type: "apiKey" | "http" | "unsupported";
  readonly location: "header" | "query" | null;
  readonly parameterName: string | null;
  readonly bearer: boolean;
}

export interface ApiOperation {
  readonly method: string;
  readonly path: string;
  readonly operationId: string | null;
  readonly displayName: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly parameters: readonly ApiParameter[];
  readonly requestBody: ApiRequestBody | null;
  readonly responses: readonly ApiResponse[];
  readonly securityRequirements: readonly ApiSecurityRequirement[];
  readonly securityGroups?: readonly (readonly ApiSecurityRequirement[])[];
  readonly risk: RiskClassification;
}

export interface ApiDefinition {
  readonly title: string;
  readonly version: string;
  readonly openapiVersion: string;
  readonly servers: readonly ApiServer[];
  readonly securitySchemes: readonly ApiSecurityScheme[];
  readonly operations: readonly ApiOperation[];
  readonly warnings: readonly SecurityWarning[];
  readonly unsupported: readonly string[];
}

export interface OpenApiParseOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export interface ParsedOpenApiDocument {
  readonly format: "json" | "yaml";
  readonly definition: ApiDefinition;
  readonly normalizedDocument: Readonly<Record<string, unknown>>;
}

export interface OpenApiAdapter {
  parseAndNormalize(
    document: string,
    options?: OpenApiParseOptions,
  ): ParsedOpenApiDocument;
}

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly actorId?: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
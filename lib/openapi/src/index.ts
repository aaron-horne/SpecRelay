import { createHash } from "node:crypto";
import {
  parseDocument,
  type Document,
  type ParsedNode,
  type ToJSOptions,
} from "yaml";
import type {
  ApiDefinition,
  ApiOperation,
  ApiParameter,
  ApiRequestBody,
  ApiResponse,
  ApiSecurityRequirement,
  ApiSecurityScheme,
  OpenApiAdapter,
  OpenApiParseOptions,
  ParsedOpenApiDocument,
  SecurityWarning,
} from "@workspace/core";
import { classifyOperationRisk } from "@workspace/security";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 50_000;

const nonOperationPathKeys = new Set([
  "$ref",
  "summary",
  "description",
  "servers",
  "parameters",
]);

type UnknownRecord = Record<string, unknown>;

export class OpenApiValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "OpenApiValidationError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function checkComplexity(
  root: UnknownRecord,
  maxDepth: number,
  maxNodes: number,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new OpenApiValidationError(
        "OpenAPI document contains too many nodes",
        "DOCUMENT_TOO_COMPLEX",
      );
    }
    if (current.depth > maxDepth) {
      throw new OpenApiValidationError(
        "OpenAPI document is nested too deeply",
        "DOCUMENT_TOO_DEEP",
      );
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const item of Object.values(current.value)) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseYaml(document: string): UnknownRecord {
  let parsed: Document.Parsed<ParsedNode, true>;
  try {
    parsed = parseDocument(document, {
      schema: "core",
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    }) as Document.Parsed<ParsedNode, true>;
  } catch (error) {
    throw new OpenApiValidationError(
      "Malformed YAML document",
      "MALFORMED_YAML",
      [error instanceof Error ? error.message : "Unknown YAML parse error"],
    );
  }

  if (parsed.errors.length > 0) {
    throw new OpenApiValidationError(
      "Malformed or unsafe YAML document",
      "MALFORMED_YAML",
      parsed.errors.map((error) => error.message),
    );
  }

  const unsafeWarnings = parsed.warnings.filter((warning) =>
    /unresolved tag|unsupported tag/i.test(warning.message),
  );
  if (unsafeWarnings.length > 0) {
    throw new OpenApiValidationError(
      "Custom YAML tags are not permitted",
      "MALFORMED_YAML",
      unsafeWarnings.map((warning) => warning.message),
    );
  }

  try {
    const result = parsed.toJS({
      maxAliasCount: 0,
    } satisfies ToJSOptions) as unknown;
    if (!isRecord(result)) {
      throw new OpenApiValidationError(
        "OpenAPI document root must be an object",
        "INVALID_DOCUMENT_ROOT",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof OpenApiValidationError) throw error;
    throw new OpenApiValidationError(
      "YAML aliases and recursive structures are not permitted",
      "YAML_ALIAS_BLOCKED",
      [error instanceof Error ? error.message : "Unsafe YAML structure"],
    );
  }
}

function parseJson(document: string): UnknownRecord {
  try {
    const parsed = JSON.parse(document) as unknown;
    if (!isRecord(parsed)) {
      throw new OpenApiValidationError(
        "OpenAPI document root must be an object",
        "INVALID_DOCUMENT_ROOT",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof OpenApiValidationError) throw error;
    throw new OpenApiValidationError(
      "Malformed JSON document",
      "MALFORMED_JSON",
      [error instanceof Error ? error.message : "Unknown JSON parse error"],
    );
  }
}

function collectRefs(root: UnknownRecord): string[] {
  const refs: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isRecord(value)) {
      if (typeof value.$ref === "string") refs.push(value.$ref);
      stack.push(...Object.values(value));
    }
  }
  return refs;
}

function resolvePointer(root: UnknownRecord, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const encodedSegment of pointer.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as UnknownRecord)[segment];
  }
  return current;
}

function hasReferenceCycle(root: UnknownRecord, refs: readonly string[]): boolean {
  const uniqueRefs = [...new Set(refs.filter((ref) => ref.startsWith("#/")))];
  const edges = new Map<string, string[]>();
  for (const ref of uniqueRefs) {
    const target = resolvePointer(root, ref);
    const childRefs =
      isRecord(target) || Array.isArray(target)
        ? collectRefs(
            isRecord(target) ? target : ({ value: target } as UnknownRecord),
          ).filter((child) => child.startsWith("#/"))
        : [];
    edges.set(ref, [...new Set(childRefs)]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ref: string): boolean => {
    if (visiting.has(ref)) return true;
    if (visited.has(ref)) return false;
    visiting.add(ref);
    for (const child of edges.get(ref) ?? []) {
      if (visit(child)) return true;
    }
    visiting.delete(ref);
    visited.add(ref);
    return false;
  };

  return uniqueRefs.some(visit);
}

function parseParameter(value: unknown): ApiParameter | null {
  if (!isRecord(value)) return null;
  const location = value.in;
  if (
    location !== "path" &&
    location !== "query" &&
    location !== "header" &&
    location !== "cookie"
  ) {
    return null;
  }
  const schema = isRecord(value.schema) ? value.schema : null;
  return {
    name: typeof value.name === "string" ? value.name : "unnamed",
    location,
    required: location === "path" || value.required === true,
    schemaType: schema ? stringOrNull(schema.type) : null,
    description: stringOrNull(value.description),
  };
}

function parseRequestBody(value: unknown): ApiRequestBody | null {
  if (!isRecord(value)) return null;
  const content = isRecord(value.content) ? value.content : {};
  return {
    required: value.required === true,
    contentTypes: Object.keys(content),
    description: stringOrNull(value.description),
  };
}

function parseResponses(value: unknown): ApiResponse[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([statusCode, response]) => {
    const record = isRecord(response) ? response : {};
    const content = isRecord(record.content) ? record.content : {};
    return {
      statusCode,
      description: stringOrNull(record.description),
      contentTypes: Object.keys(content),
    };
  });
}

function parseSecurityGroups(value: unknown): ApiSecurityRequirement[][] {
  if (!Array.isArray(value)) return [];
  const groups: ApiSecurityRequirement[][] = [];
  for (const requirement of value) {
    if (!isRecord(requirement)) continue;
    const group: ApiSecurityRequirement[] = [];
    for (const [scheme, scopes] of Object.entries(requirement)) {
      group.push({ scheme, scopes: stringArray(scopes) });
    }
    groups.push(group);
  }
  return groups;
}

function parseSecuritySchemes(
  root: UnknownRecord,
  unsupported: string[],
): ApiSecurityScheme[] {
  const components = isRecord(root.components) ? root.components : {};
  const schemes = isRecord(components.securitySchemes)
    ? components.securitySchemes
    : {};
  const parsed: ApiSecurityScheme[] = [];
  for (const [name, value] of Object.entries(schemes)) {
    const scheme = isRecord(value) ? value : {};
    if (scheme.type === "apiKey" && (scheme.in === "header" || scheme.in === "query") && typeof scheme.name === "string") {
      parsed.push({
        name,
        type: "apiKey",
        location: scheme.in,
        parameterName: scheme.name,
        bearer: false,
      });
      continue;
    }
    if (scheme.type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "bearer") {
      parsed.push({
        name,
        type: "http",
        location: "header",
        parameterName: "Authorization",
        bearer: true,
      });
      continue;
    }
    unsupported.push(name);
  }
  return parsed;
}

function fallbackOperationName(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? `by ${segment.slice(1, -1)}`
        : segment.replaceAll(/[-_]+/g, " "),
    );
  return `${method.toUpperCase()} ${segments.join(" ") || "root"}`;
}

function normalizeOperations(
  root: UnknownRecord,
  warnings: SecurityWarning[],
  securitySchemes: readonly ApiSecurityScheme[],
): ApiOperation[] {
  const paths = isRecord(root.paths) ? root.paths : {};
  const operations: ApiOperation[] = [];
  const operationIds = new Set<string>();
  const duplicateOperationIds = new Set<string>();
  const rootSecurity = root.security;

  for (const [path, pathValue] of Object.entries(paths)) {
    if (!path.startsWith("/") || !isRecord(pathValue)) continue;
    const sharedParameters = Array.isArray(pathValue.parameters)
      ? pathValue.parameters
      : [];
    for (const [methodKey, operationValue] of Object.entries(pathValue)) {
      if (nonOperationPathKeys.has(methodKey) || !isRecord(operationValue)) {
        continue;
      }
      const method = methodKey.toUpperCase();
      const operationId = stringOrNull(operationValue.operationId);
      if (operationId) {
        if (operationIds.has(operationId)) duplicateOperationIds.add(operationId);
        operationIds.add(operationId);
      }
      const parameters = [
        ...sharedParameters,
        ...(Array.isArray(operationValue.parameters)
          ? operationValue.parameters
          : []),
      ]
        .map(parseParameter)
        .filter((parameter): parameter is ApiParameter => parameter !== null);
      const summary = stringOrNull(operationValue.summary);
      const description = stringOrNull(operationValue.description);
      const tags = stringArray(operationValue.tags);

      const securityGroups = parseSecurityGroups(operationValue.security ?? rootSecurity);
      const securityRequirements = securityGroups.flat();
      for (const requirement of securityRequirements) {
        if (!securitySchemes.some((scheme) => scheme.name === requirement.scheme)) {
          warnings.push({
            code: "UNKNOWN_SECURITY_SCHEME",
            message: `Security scheme "${requirement.scheme}" is not declared`,
            path,
            severity: "warning",
          });
        }
      }
      operations.push({
        method,
        path,
        operationId,
        displayName:
          operationId ?? summary ?? fallbackOperationName(method, path),
        summary,
        description,
        tags,
        parameters,
        requestBody: parseRequestBody(operationValue.requestBody),
        responses: parseResponses(operationValue.responses),
        securityRequirements,
        securityGroups,
        risk: classifyOperationRisk({
          method,
          path,
          operationId,
          summary,
          description,
          tags,
        }),
      });
    }
  }

  for (const operationId of duplicateOperationIds) {
    warnings.push({
      code: "DUPLICATE_OPERATION_ID",
      message: `operationId "${operationId}" is not unique`,
      path: null,
      severity: "warning",
    });
  }

  return operations;
}

function validateVersion(root: UnknownRecord): string {
  const version = root.openapi;
  if (
    typeof version !== "string" ||
    !/^3\.(0|1|2)(?:\.\d+)?$/.test(version)
  ) {
    throw new OpenApiValidationError(
      "Only OpenAPI 3.0.x, 3.1.x, and 3.2.x documents are supported",
      "UNSUPPORTED_OPENAPI_VERSION",
    );
  }
  return version;
}

export class SecureOpenApiAdapter implements OpenApiAdapter {
  parseAndNormalize(
    document: string,
    options: OpenApiParseOptions = {},
  ): ParsedOpenApiDocument {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const byteLength = Buffer.byteLength(document, "utf8");
    if (byteLength > maxBytes) {
      throw new OpenApiValidationError(
        `OpenAPI document exceeds the ${maxBytes}-byte limit`,
        "DOCUMENT_TOO_LARGE",
      );
    }

    const trimmed = document.trim();
    if (trimmed.length === 0) {
      throw new OpenApiValidationError(
        "OpenAPI document is empty",
        "EMPTY_DOCUMENT",
      );
    }

    const format = trimmed.startsWith("{") ? "json" : "yaml";
    const root = format === "json" ? parseJson(document) : parseYaml(document);
    checkComplexity(
      root,
      options.maxDepth ?? DEFAULT_MAX_DEPTH,
      options.maxNodes ?? DEFAULT_MAX_NODES,
    );

    const openapiVersion = validateVersion(root);
    if (!isRecord(root.info) || typeof root.info.title !== "string") {
      throw new OpenApiValidationError(
        "OpenAPI info.title is required",
        "MISSING_INFO",
      );
    }
    if (!isRecord(root.paths)) {
      throw new OpenApiValidationError(
        "OpenAPI paths object is required",
        "MISSING_PATHS",
      );
    }

    const refs = collectRefs(root);
    const remoteRefs = refs.filter((ref) => !ref.startsWith("#/"));
    if (remoteRefs.length > 0) {
      throw new OpenApiValidationError(
        "Remote OpenAPI references are blocked in V0.1",
        "REMOTE_REFERENCE_BLOCKED",
        [...new Set(remoteRefs)],
      );
    }

    const warnings: SecurityWarning[] = [];
    const unsupported: string[] = [];
    if (hasReferenceCycle(root, refs)) {
      warnings.push({
        code: "REFERENCE_CYCLE",
        message:
          "The document contains an internal reference cycle; references were not dereferenced",
        path: null,
        severity: "warning",
      });
    }

    const servers = Array.isArray(root.servers)
      ? root.servers
          .filter(isRecord)
          .filter((server) => typeof server.url === "string")
          .map((server) => ({
            url: server.url as string,
            description: stringOrNull(server.description),
          }))
      : [];

    const securitySchemes = parseSecuritySchemes(root, unsupported);
    const definition: ApiDefinition = {
      title: root.info.title,
      version:
        typeof root.info.version === "string" ? root.info.version : "unknown",
      openapiVersion,
      servers,
      securitySchemes,
      operations: normalizeOperations(root, warnings, securitySchemes),
      warnings,
      unsupported,
    };

    return {
      format,
      definition,
      normalizedDocument: root,
    };
  }
}

export function hashOpenApiDocument(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}
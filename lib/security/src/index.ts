import type {
  ApiOperation,
  ApiSecurityScheme,
  JsonValue,
  RiskClassification,
  WorkspaceContext,
} from "@workspace/core";

export type PolicyDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface PolicyEvaluationContext extends WorkspaceContext {
  readonly operation: ApiOperation;
  readonly operationRecordId: string;
  readonly apiSourceId: string;
  readonly credentialReference?: string;
  readonly requestedAction: "EXECUTE_OPERATION";
  readonly requestedAt: Date;
}

export interface PolicyEngine {
  evaluate(context: PolicyEvaluationContext): Promise<PolicyDecision>;
}

export interface OutboundRequestCandidate {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly apiSourceId: string;
  readonly operationId: string;
  readonly operation: ApiOperation;
  readonly securitySchemes?: readonly ApiSecurityScheme[];
  readonly securityGroups?: readonly (readonly { scheme: string; scopes: readonly string[] }[])[];
  readonly destination: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly credentialReference?: string;
  readonly proposedRedirects?: readonly URL[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface OutboundResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface OutboundRequestBroker {
  validate(candidate: OutboundRequestCandidate): Promise<OutboundValidationResult>;
  execute(candidate: OutboundRequestCandidate): Promise<OutboundResponse>;
}

export interface CredentialReference {
  readonly id: string;
  readonly workspaceId: string;
  readonly apiSourceId: string;
  readonly destinationHost: string;
  readonly status: "ACTIVE" | "DISABLED" | "REVOKED";
}

export interface CredentialProvider {
  inspect(referenceId: string): Promise<CredentialReference | null>;
  resolve(input: {
    workspaceId: string;
    apiSourceId: string;
    destinationHost: string;
    groups: readonly (readonly { scheme: string; scopes: readonly string[] }[])[];
    schemes: readonly ApiSecurityScheme[];
  }): Promise<ManagedCredential[] | null>;
  isConfigured(input: {
    workspaceId: string;
    apiSourceId: string;
    destinationHost: string;
    groups: readonly (readonly { scheme: string; scopes: readonly string[] }[])[];
    schemes: readonly ApiSecurityScheme[];
  }): Promise<boolean>;
}

export interface ManagedCredential {
  readonly schemeName: string;
  readonly type: "API_KEY" | "BEARER";
  readonly location: "header" | "query";
  readonly parameterName: string;
  readonly secret: string;
}

export interface OutboundValidationResult {
  readonly allowed: boolean;
  readonly mode: "ENFORCED";
  readonly reason: string;
  readonly resolvedAddresses: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly errorCode?: OutboundBrokerErrorCode;
  readonly managedCredentials?: readonly ManagedCredential[];
}

export type OutboundBrokerErrorCode =
  | "VALIDATION_DENIED"
  | "TIMEOUT"
  | "RESPONSE_LIMIT"
  | "REDIRECT_BLOCKED"
  | "UPSTREAM_FAILURE"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_REJECTED"
  | "UPSTREAM_SECRET_REFLECTION";

export class OutboundBrokerError extends Error {
  constructor(
    readonly code: OutboundBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutboundBrokerError";
  }
}

export interface AuditEventInput extends WorkspaceContext {
  readonly eventType: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface AuditService {
  record(event: AuditEventInput): Promise<void>;
}

export class DefaultDenyPolicyEngine implements PolicyEngine {
  async evaluate(_context: PolicyEvaluationContext): Promise<PolicyDecision> {
    return "DENY";
  }
}

export class DenyOutboundRequestBroker implements OutboundRequestBroker {
  async validate(_candidate: OutboundRequestCandidate): Promise<OutboundValidationResult> {
    return {
      allowed: false,
      mode: "ENFORCED",
      reason: "Outbound validation is not configured",
      resolvedAddresses: [],
      timeoutMs: 0,
      maxResponseBytes: 0,
    };
  }
  async execute(_candidate: OutboundRequestCandidate): Promise<OutboundResponse> {
    throw new Error("Outbound execution is intentionally disabled");
  }
}

const destructiveTerms =
  /\b(delete|destroy|remove|revoke|terminate|purge|erase|drop|cancel)\b/i;
const writeTerms =
  /\b(create|update|write|set|send|upload|import|execute|trigger|approve)\b/i;

const rank: Record<RiskClassification, number> = {
  READ_LIKE: 0,
  WRITE: 1,
  DESTRUCTIVE: 2,
  UNKNOWN: 3,
};

function escalate(
  current: RiskClassification,
  candidate: RiskClassification,
): RiskClassification {
  return rank[candidate] > rank[current] ? candidate : current;
}

export function classifyOperationRisk(input: {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string | null;
  readonly summary?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly string[];
}): RiskClassification {
  const method = input.method.toUpperCase();
  let classification: RiskClassification;

  switch (method) {
    case "GET":
    case "HEAD":
      classification = "READ_LIKE";
      break;
    case "POST":
    case "PUT":
    case "PATCH":
      classification = "WRITE";
      break;
    case "DELETE":
      classification = "DESTRUCTIVE";
      break;
    default:
      classification = "UNKNOWN";
  }

  const metadata = [
    input.path,
    input.operationId ?? "",
    input.summary ?? "",
    input.description ?? "",
    ...(input.tags ?? []),
  ].join(" ");

  if (destructiveTerms.test(metadata)) {
    classification = escalate(classification, "DESTRUCTIVE");
  } else if (writeTerms.test(metadata)) {
    classification = escalate(classification, "WRITE");
  }

  return classification;
}

export * from "./https-broker";
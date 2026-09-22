import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import * as ipaddr from "ipaddr.js";
import type {
  AuditService,
  CredentialProvider,
  OutboundRequestBroker,
  OutboundRequestCandidate,
  OutboundResponse,
  OutboundValidationResult,
  PolicyEngine,
  ManagedCredential,
} from "./index";
import { OutboundBrokerError } from "./index";

export interface HostResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface HttpsGetTransport {
  get(input: {
    url: URL;
    address: string;
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<OutboundResponse>;
}

export interface NodeHttpsGetTransportOptions {
  readonly ca?: string | Buffer;
}

export interface HttpsOutboundRequestBrokerOptions {
  /**
   * Test-only escape hatch for a local HTTPS fixture. Production construction
   * leaves this empty, so loopback/private-IP protections remain enforced.
   */
  readonly allowPrivateAddressesForTests?: readonly string[];
}

const protectedHeaders = new Set([
  "authorization", "cookie", "host", "proxy-authorization",
  "proxy-connection", "x-api-key", "content-length", "transfer-encoding",
  "connection", "upgrade", "forwarded", "te", "trailer", "keep-alive",
  "expect", "via", "content-type", "content-encoding", "content-range", "range",
]);
const responseHeaderAllowlist = new Set([
  "content-type", "content-length", "etag", "last-modified", "cache-control",
]);

const unsafeCredentialHeaderNames = new Set([
  "authorization", "cookie", "host", "content-length", "transfer-encoding",
  "connection", "upgrade", "forwarded", "proxy-authorization", "proxy-connection",
  "te", "trailer", "keep-alive", "expect", "via", "content-type", "content-encoding",
  "content-range", "range",
]);

export function validateManagedCredentialName(
  name: string,
  location: "header" | "query",
  bearer = false,
): boolean {
  if (
    typeof name !== "string" ||
    !name ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) return false;
  if (location === "header") {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return false;
    const lower = name.toLowerCase();
    if (bearer) return lower === "authorization";
    return !unsafeCredentialHeaderNames.has(lower) &&
      !lower.startsWith("sec-") &&
      !lower.startsWith("proxy-") &&
      !lower.startsWith("forwarded") &&
      !lower.startsWith("x-forwarded-");
  }
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) &&
    !["__proto__", "prototype", "constructor"].includes(name.toLowerCase());
}

export function isBlockedIp(address: string): boolean {
  if (!isIP(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).range() !== "unicast") return true;
  const blocked = parsed.kind() === "ipv4" ? [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.168.0.0/16", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  ] : [
    "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
    "100::/64", "64:ff9b:1::/48", "2001:db8::/32", "2001:2::/48",
    "2001:10::/28", "3fff::/20",
  ];
  return blocked.some((range) => {
    const cidr = ipaddr.parseCIDR(range);
    return parsed.kind() === "ipv4"
      ? (parsed as ipaddr.IPv4).match(cidr as [ipaddr.IPv4, number])
      : (parsed as ipaddr.IPv6).match(cidr as [ipaddr.IPv6, number]);
  });
}

function invalidHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  return protectedHeaders.has(lower) ||
    lower.startsWith("x-forwarded-") ||
    /[\r\n]/.test(name + value);
}

function secretReflected(response: OutboundResponse, credentials: readonly ManagedCredential[]): boolean {
  const values = credentials.flatMap((credential) => {
    const bearer = credential.type === "BEARER" ? `Bearer ${credential.secret}` : null;
    return [credential.secret, bearer, encodeURIComponent(credential.secret), bearer && encodeURIComponent(bearer)]
      .filter((value): value is string => Boolean(value));
  });
  if (!values.length) return false;
  const body = Buffer.from(response.body).toString("utf8");
  return values.some((value) =>
    body.includes(value) ||
    Object.values(response.headers).some((header) => header.includes(value)),
  );
}

function supportedGroup(
  group: readonly { scheme: string; scopes: readonly string[] }[],
  schemes: readonly import("@workspace/core").ApiSecurityScheme[],
): boolean {
  const byName = new Map(schemes.map((scheme) => [scheme.name, scheme]));
  return group.length > 0 && group.every((requirement) => {
    const scheme = byName.get(requirement.scheme);
    return Boolean(
      scheme && (
        (scheme.type === "apiKey" && (scheme.location === "header" || scheme.location === "query") &&
          validateManagedCredentialName(scheme.parameterName ?? "", scheme.location)) ||
        (scheme.type === "http" && scheme.bearer && scheme.location === "header" &&
          validateManagedCredentialName(scheme.parameterName ?? "", "header", true))
      ),
    );
  });
}

export class NodeHttpsGetTransport implements HttpsGetTransport {
  constructor(private readonly options: NodeHttpsGetTransportOptions = {}) {}

  async get(input: Parameters<HttpsGetTransport["get"]>[0]): Promise<OutboundResponse> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname: input.address,
        port: input.url.port ? Number(input.url.port) : 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        servername: input.url.hostname,
        headers: { ...input.headers, host: input.url.host },
        timeout: input.timeoutMs,
        rejectUnauthorized: true,
        ca: this.options.ca,
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new OutboundBrokerError("REDIRECT_BLOCKED", "Upstream redirects are not permitted"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > input.maxResponseBytes) {
            response.destroy(new OutboundBrokerError("RESPONSE_LIMIT", "Upstream response exceeded the configured byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (!responseHeaderAllowlist.has(name) || value === undefined) continue;
            headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
          }
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
        response.on("error", reject);
      });
      request.on("timeout", () => {
        request.destroy(new OutboundBrokerError("TIMEOUT", "Upstream request timed out"));
      });
      request.on("error", (error) => {
        reject(error instanceof OutboundBrokerError
          ? error
          : new OutboundBrokerError("UPSTREAM_FAILURE", "Upstream request failed"));
      });
      request.end();
    });
  }
}

export class HttpsOutboundRequestBroker implements OutboundRequestBroker {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly credentials: CredentialProvider,
    private readonly audit: AuditService,
    private readonly resolver: HostResolver,
    private readonly transport: HttpsGetTransport = new NodeHttpsGetTransport(),
    private readonly options: HttpsOutboundRequestBrokerOptions = {},
  ) {}

  async validate(candidate: OutboundRequestCandidate): Promise<OutboundValidationResult> {
    const timeoutMs = candidate.timeoutMs ?? 5_000;
    const maxResponseBytes = candidate.maxResponseBytes ?? 1_048_576;
    const deny = async (
      reason: string,
      addresses: readonly string[] = [],
      errorCode: import("./index").OutboundBrokerErrorCode = "VALIDATION_DENIED",
    ) => {
      await this.audit.record({
        workspaceId: candidate.workspaceId,
        actorId: candidate.actorId,
        eventType: "outbound.validation_denied",
        resourceType: "api_operation",
        resourceId: candidate.operationId,
        metadata: { reason, destinationHost: candidate.destination.hostname },
      });
      return {
        allowed: false,
        mode: "ENFORCED" as const,
        reason,
        resolvedAddresses: addresses,
        timeoutMs,
        maxResponseBytes,
        errorCode,
      };
    };

    if (candidate.method.toUpperCase() !== "GET" || candidate.operation.method.toUpperCase() !== "GET") {
      return deny("Only GET operations are executable");
    }
    if (candidate.body) return deny("Request bodies are not permitted");
    if ((candidate.proposedRedirects?.length ?? 0) > 0) return deny("Redirects are not permitted");
    if (candidate.destination.protocol !== "https:") return deny("Only HTTPS destinations are permitted");
    const host = candidate.destination.hostname.toLowerCase();
    const credentialHost = candidate.destination.host.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
      return deny("Protected destination host");
    }
    if (timeoutMs < 1 || timeoutMs > 10_000) return deny("Timeout exceeds broker limit");
    if (maxResponseBytes < 1 || maxResponseBytes > 5_242_880) return deny("Response size exceeds broker limit");
    const schemes = candidate.securitySchemes ?? [];
    const groups = candidate.securityGroups ?? candidate.operation.securityGroups ?? [];
    const managedHeaderNames = new Set(
      schemes
        .filter((scheme) => scheme.type === "apiKey" && scheme.location === "header" && scheme.parameterName)
        .map((scheme) => scheme.parameterName!.toLowerCase()),
    );
    for (const scheme of schemes) {
      if (scheme.type === "apiKey" && scheme.location && scheme.parameterName &&
          !validateManagedCredentialName(scheme.parameterName, scheme.location)) {
        return deny("Invalid managed credential name", [], "VALIDATION_DENIED");
      }
      if (scheme.type === "http" && scheme.bearer &&
          !validateManagedCredentialName(scheme.parameterName ?? "", "header", true)) {
        return deny("Invalid managed credential name", [], "VALIDATION_DENIED");
      }
    }
    managedHeaderNames.add("authorization");
    for (const [name, value] of Object.entries(candidate.headers)) {
      if (invalidHeader(name, value)) return deny("Protected or invalid request header");
      if (managedHeaderNames.has(name.toLowerCase())) return deny("Protected or invalid request header");
    }

    const first = [...await this.resolver.resolve(host)].sort();
    const second = [...await this.resolver.resolve(host)].sort();
    if (first.length === 0 || first.join(",") !== second.join(",")) {
      return deny("DNS rebinding detected", first);
    }
    const allowedPrivateAddresses = new Set(this.options.allowPrivateAddressesForTests ?? []);
    if (first.some((address) => isBlockedIp(address) && !allowedPrivateAddresses.has(address))) {
      return deny("Destination resolves to a protected IP", first);
    }

    const decision = await this.policy.evaluate({
      workspaceId: candidate.workspaceId,
      actorId: candidate.actorId,
      apiSourceId: candidate.apiSourceId,
      operation: candidate.operation,
      operationRecordId: candidate.operationId,
      requestedAction: "EXECUTE_OPERATION",
      requestedAt: new Date(),
    });
    if (decision !== "ALLOW") return deny(`Policy decision: ${decision}`, first);

    let managedCredentials: ManagedCredential[] = [];
    if (groups.length > 0) {
      if (!groups.some((group) => group.length === 0)) {
        for (const group of groups) {
          if (!supportedGroup(group, schemes)) continue;
          const resolved = await this.credentials.resolve({
            workspaceId: candidate.workspaceId,
            apiSourceId: candidate.apiSourceId,
            destinationHost: credentialHost,
            groups: [group],
            schemes,
          });
          if (resolved) {
            managedCredentials = resolved;
            break;
          }
        }
        if (managedCredentials.length === 0) {
          return deny("Required credential is unavailable", first, "CREDENTIAL_UNAVAILABLE");
        }
      }
    }

    await this.audit.record({
      workspaceId: candidate.workspaceId,
      actorId: candidate.actorId,
      eventType: "outbound.validation_allowed",
      resourceType: "api_operation",
      resourceId: candidate.operationId,
      metadata: { destinationHost: host, mode: "LIVE_GET" },
    });
    return {
      allowed: true,
      mode: "ENFORCED",
      reason: "Validated for one HTTPS GET",
      resolvedAddresses: first,
      timeoutMs,
      maxResponseBytes,
      managedCredentials,
    };
  }

  async execute(candidate: OutboundRequestCandidate): Promise<OutboundResponse> {
    const validation = await this.validate(candidate);
    if (!validation.allowed || !validation.resolvedAddresses[0]) {
      throw new OutboundBrokerError(validation.errorCode ?? "VALIDATION_DENIED", validation.reason);
    }
    const headers = { ...candidate.headers };
    const destination = new URL(candidate.destination.href);
    for (const credential of validation.managedCredentials ?? []) {
      if (credential.location === "query") {
        destination.searchParams.set(credential.parameterName, credential.secret);
      } else {
        headers[credential.parameterName] = credential.type === "BEARER"
          ? `Bearer ${credential.secret}`
          : credential.secret;
      }
    }
    try {
      const response = await this.transport.get({
        url: destination,
        address: validation.resolvedAddresses[0],
        headers,
        timeoutMs: validation.timeoutMs,
        maxResponseBytes: validation.maxResponseBytes,
      });
      if (secretReflected(response, validation.managedCredentials ?? [])) {
        await this.audit.record({
          workspaceId: candidate.workspaceId,
          actorId: candidate.actorId,
          eventType: "outbound.secret_reflection",
          resourceType: "api_operation",
          resourceId: candidate.operationId,
          metadata: { destinationHost: candidate.destination.hostname, code: "UPSTREAM_SECRET_REFLECTION" },
        });
        throw new OutboundBrokerError(
          "UPSTREAM_SECRET_REFLECTION",
          "Upstream response contained managed credential material",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof OutboundBrokerError) throw error;
      const message = error instanceof Error ? error.message : "";
      if ((validation.managedCredentials ?? []).some((credential) =>
        message.includes(credential.secret) ||
        message.includes(encodeURIComponent(credential.secret)),
      )) {
        throw new OutboundBrokerError(
          "UPSTREAM_SECRET_REFLECTION",
          "Upstream response contained managed credential material",
        );
      }
      throw error;
    }
  }
}

export class EmptyCredentialProvider implements CredentialProvider {
  async inspect(): Promise<null> {
    return null;
  }
  async resolve(): Promise<ManagedCredential[] | null> {
    return null;
  }
  async isConfigured(): Promise<boolean> {
    return false;
  }
}
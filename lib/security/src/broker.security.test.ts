import { describe, expect, it } from "vitest";
import {
  HttpsOutboundRequestBroker,
  type AuditService,
  type CredentialProvider,
  type OutboundRequestCandidate,
  type PolicyDecision,
  type PolicyEngine,
  type HttpsGetTransport,
  type ManagedCredential,
  isBlockedIp,
} from "./index";

const operation = {
  method: "GET", path: "/items", operationId: "listItems", displayName: "List items",
  summary: null, description: null, tags: [], parameters: [], requestBody: null,
  responses: [], securityRequirements: [], risk: "READ_LIKE" as const,
};

function candidate(overrides: Partial<OutboundRequestCandidate> = {}): OutboundRequestCandidate {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    actorId: "user_test",
    apiSourceId: "22222222-2222-4222-8222-222222222222",
    operationId: "33333333-3333-4333-8333-333333333333",
    operation,
    destination: new URL("https://api.example.com/items"),
    method: "GET",
    headers: { accept: "application/json" },
    ...overrides,
  };
}

function broker(options: {
  decision?: PolicyDecision;
  answers?: readonly (readonly string[])[];
  credential?: Awaited<ReturnType<CredentialProvider["inspect"]>>;
  resolved?: ManagedCredential[] | null;
  transport?: HttpsGetTransport;
} = {}) {
  const events: string[] = [];
  let index = 0;
  const policy: PolicyEngine = { async evaluate() { return options.decision ?? "ALLOW"; } };
  const credentials: CredentialProvider = {
    async inspect() { return options.credential ?? null; },
    async resolve() { return options.resolved ?? null; },
    async isConfigured() { return false; },
  };
  const audit: AuditService = { async record(event) { events.push(event.eventType); } };
  const answers = options.answers ?? [["93.184.216.34"], ["93.184.216.34"]];
  return {
    events,
    value: new HttpsOutboundRequestBroker(policy, credentials, audit, {
      async resolve() { return answers[Math.min(index++, answers.length - 1)]!; },
    }, options.transport),
  };
}

describe("HTTPS outbound request broker", () => {
  it("blocks HTTP, private and metadata destinations", async () => {
    expect((await broker().value.validate(candidate({ destination: new URL("http://example.com") }))).allowed).toBe(false);
    expect((await broker({ answers: [["169.254.169.254"], ["169.254.169.254"]] }).value.validate(candidate())).reason).toMatch(/protected IP/);
    expect((await broker().value.validate(candidate({ destination: new URL("https://metadata.google.internal") }))).allowed).toBe(false);
  });

  it("blocks DNS rebinding", async () => {
    const result = await broker({ answers: [["93.184.216.34"], ["93.184.216.35"]] }).value.validate(candidate());
    expect(result.reason).toMatch(/rebinding/);
  });

  it("validates every redirect and limits redirect depth", async () => {
    const insecure = await broker().value.validate(candidate({ proposedRedirects: [new URL("http://example.com/next")] }));
    expect(insecure.allowed).toBe(false);
    const many = Array.from({ length: 4 }, (_, i) => new URL(`https://example.com/${i}`));
    expect((await broker().value.validate(candidate({ proposedRedirects: many }))).reason).toMatch(/redirects/i);
  });

  it("rejects protected headers and header injection", async () => {
    expect((await broker().value.validate(candidate({ headers: { Authorization: "secret" } }))).allowed).toBe(false);
    expect((await broker().value.validate(candidate({ headers: { "x-ok": "a\r\nInjected: yes" } }))).allowed).toBe(false);
    for (const name of ["TE", "Trailer", "Keep-Alive", "Expect", "Via"]) {
      expect((await broker().value.validate(candidate({ headers: { [name]: "value" } }))).allowed).toBe(false);
    }
  });

  it("enforces request, response, and timeout bounds", async () => {
    expect((await broker().value.validate(candidate({ method: "POST" }))).allowed).toBe(false);
    expect((await broker().value.validate(candidate({ body: new Uint8Array(1_048_577) }))).allowed).toBe(false);
    expect((await broker().value.validate(candidate({ maxResponseBytes: 5_242_881 }))).allowed).toBe(false);
    expect((await broker().value.validate(candidate({ timeoutMs: 10_001 }))).allowed).toBe(false);
  });

  it("rejects authenticated execution when the required credential is unavailable", async () => {
    const result = await broker().value.validate(candidate({
      securitySchemes: [{
        name: "apiKey",
        type: "apiKey",
        location: "header",
        parameterName: "X-API-Key",
        bearer: false,
      }],
      securityGroups: [[{ scheme: "apiKey", scopes: [] }]],
    }));
    expect(result.reason).toMatch(/credential is unavailable/i);
    expect(result.errorCode).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("cannot bypass a deny or approval policy", async () => {
    expect((await broker({ decision: "DENY" }).value.validate(candidate())).allowed).toBe(false);
    expect((await broker({ decision: "REQUIRE_APPROVAL" }).value.validate(candidate())).allowed).toBe(false);
  });

  it("executes a validated HTTPS GET through the pinned transport", async () => {
    const fixture = broker({
      transport: {
        async get(input) {
          expect(input.address).toBe("93.184.216.34");
          expect(input.url.href).toBe("https://api.example.com/items");
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode('{"ok":true}'),
          };
        },
      },
    });
    const result = await fixture.value.validate(candidate());
    expect(result).toMatchObject({ allowed: true, mode: "ENFORCED" });
    expect(fixture.events).toContain("outbound.validation_allowed");
    await expect(fixture.value.execute(candidate())).resolves.toMatchObject({ status: 200 });
  });

  it("injects managed header and query credentials only after validation", async () => {
    const fixture = broker({
      resolved: [{
        schemeName: "key",
        type: "API_KEY",
        location: "header",
        parameterName: "X-API-Key",
        secret: "secret-value",
      }],
      transport: {
        async get(input) {
          expect(input.headers["X-API-Key"]).toBe("secret-value");
          expect(input.url.search).toBe("");
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      },
    });
    await expect(fixture.value.execute(candidate({
      securitySchemes: [{
        name: "key", type: "apiKey", location: "header", parameterName: "X-API-Key", bearer: false,
      }],
      securityGroups: [[{ scheme: "key", scopes: [] }]],
    }))).resolves.toMatchObject({ status: 200 });
  });

  it("injects query API keys and Bearer tokens without exposing them to callers", async () => {
    const queryFixture = broker({
      resolved: [{
        schemeName: "key",
        type: "API_KEY",
        location: "query",
        parameterName: "api_key",
        secret: "query-secret",
      }],
      transport: {
        async get(input) {
          expect(input.url.search).toBe("?api_key=query-secret");
          expect(input.headers.Authorization).toBeUndefined();
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      },
    });
    await expect(queryFixture.value.execute(candidate({
      securitySchemes: [{
        name: "key", type: "apiKey", location: "query", parameterName: "api_key", bearer: false,
      }],
      securityGroups: [[{ scheme: "key", scopes: [] }]],
    }))).resolves.toMatchObject({ status: 200 });

    const bearerFixture = broker({
      resolved: [{
        schemeName: "token",
        type: "BEARER",
        location: "header",
        parameterName: "Authorization",
        secret: "bearer-secret",
      }],
      transport: {
        async get(input) {
          expect(input.headers.Authorization).toBe("Bearer bearer-secret");
          return { status: 200, headers: {}, body: new Uint8Array() };
        },
      },
    });
    await expect(bearerFixture.value.execute(candidate({
      securitySchemes: [{
        name: "token", type: "http", location: "header", parameterName: "Authorization", bearer: true,
      }],
      securityGroups: [[{ scheme: "token", scopes: [] }]],
    }))).resolves.toMatchObject({ status: 200 });
  });

  it("blocks caller attempts to provide managed auth and credential redirects", async () => {
    const managed = {
      securitySchemes: [{
        name: "token", type: "http" as const, location: "header" as const,
        parameterName: "Authorization", bearer: true,
      }],
      securityGroups: [[{ scheme: "token", scopes: [] }]],
    };
    expect((await broker().value.validate(candidate({
      ...managed,
      headers: { Authorization: "Bearer caller" },
    }))).allowed).toBe(false);
    expect((await broker().value.validate(candidate({
      ...managed,
      proposedRedirects: [new URL("https://api.example.com/next")],
    }))).allowed).toBe(false);
  });

  it("fails closed when an upstream response reflects managed credential material", async () => {
    const secret = "secret+value";
    const fixture = broker({
      resolved: [{
        schemeName: "token", type: "BEARER", location: "header",
        parameterName: "Authorization", secret,
      }],
      transport: {
        async get() {
          return {
            status: 200,
            headers: { "x-echo": encodeURIComponent(`Bearer ${secret}`) },
            body: new TextEncoder().encode(`Bearer ${secret}`),
          };
        },
      },
    });
    await expect(fixture.value.execute(candidate({
      securitySchemes: [{
        name: "token", type: "http", location: "header", parameterName: "Authorization", bearer: true,
      }],
      securityGroups: [[{ scheme: "token", scopes: [] }]],
    }))).rejects.toMatchObject({
      code: "UPSTREAM_SECRET_REFLECTION",
      message: "Upstream response contained managed credential material",
    });
    expect(fixture.events).toContain("outbound.secret_reflection");
  });

  it("blocks reserved, private, documentation, benchmark, and mapped addresses", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
      "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
      "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
      "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
      "::ffff:192.0.2.1", "100::1", "64:ff9b:1::1",
    ]) {
      expect(isBlockedIp(address), address).toBe(true);
    }
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });
});
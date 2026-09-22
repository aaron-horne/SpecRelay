import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { auditEventsTable, db, workspaceMembershipsTable } from "@workspace/db";
import { mcpToolName } from "@workspace/mcp";
import {
  HttpsOutboundRequestBroker,
  NodeHttpsGetTransport,
} from "@workspace/security";
import app from "./app";
import { securityServices } from "./services/security";

const fixtureHostname = "gateway-fixture.test";
const originalBroker = securityServices.outboundRequestBroker;

let certificateDirectory = "";
let certificate = "";
let server: Server;
let fixtureServerUrl = "";
let resolvedHosts: string[] = [];
let receivedRequests: Array<{ method: string; url: string; host: string }> = [];
let receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];
let receivedServerNames: string[] = [];

function eventTypes(workspaceId: string, operationId: string) {
  return db
    .select({ eventType: auditEventsTable.eventType })
    .from(auditEventsTable)
    .where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.resourceId, operationId),
    ));
}

function auditRows(workspaceId: string, operationId: string) {
  return db
    .select()
    .from(auditEventsTable)
    .where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.resourceId, operationId),
    ));
}

function createLiveFixtureBroker(trustFixtureCertificate: boolean) {
  resolvedHosts = [];
  return new HttpsOutboundRequestBroker(
    securityServices.policyEngine,
    securityServices.credentialProvider,
    securityServices.auditService,
    {
      async resolve(hostname: string) {
        resolvedHosts.push(hostname);
        return ["127.0.0.1"];
      },
    },
    new NodeHttpsGetTransport(
      trustFixtureCertificate ? { ca: certificate } : {},
    ),
    { allowPrivateAddressesForTests: ["127.0.0.1"] },
  );
}

async function setupOperation(input: {
  path: string;
  operationId: string;
  parameters?: object[];
  securityScheme?: {
    name: string;
    type: "apiKey" | "bearer";
    location?: "header" | "query";
    parameterName?: string;
  };
}) {
  const workspace = await request(app)
    .post("/api/workspaces")
    .send({ name: `TLS execution ${randomUUID()}` })
    .expect(201);
  const workspaceId = workspace.body.id as string;
  const api = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis`)
    .send({ name: "Controlled TLS fixture" })
    .expect(201);
  const apiId = api.body.id as string;
  const securityScheme = input.securityScheme;
  const document = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Controlled TLS fixture", version: "1.0.0" },
    servers: [{ url: `${fixtureServerUrl}/v1` }],
    ...(securityScheme ? {
      components: {
        securitySchemes: {
          [securityScheme.name]: securityScheme.type === "bearer"
            ? { type: "http", scheme: "bearer" }
            : {
              type: "apiKey",
              in: securityScheme.location ?? "header",
              name: securityScheme.parameterName ?? "X-API-Key",
            },
        },
      },
    } : {}),
    paths: {
      [input.path]: {
        get: {
          operationId: input.operationId,
          parameters: input.parameters ?? [],
            ...(securityScheme ? { security: [{ [securityScheme.name]: [] }] } : {}),
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  const imported = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
    .send({ document })
    .expect(201);
  const operation = imported.body.operations[0];
  const operationId = operation.id as string;
  const toolName = mcpToolName({
    id: operationId,
    operationId: operation.operationId,
    displayName: operation.displayName,
    description: operation.description,
    parameters: operation.parameters,
  });
  await request(app)
    .patch(`/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operationId}`)
    .send({ enabled: true })
    .expect(200);
  return { workspaceId, apiId, operationId, toolName };
}

function callTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown> = {},
  userId?: string,
) {
  const builder = request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", "tools/call")
    .set("mcp-name", name);
  if (userId) builder.set("x-test-user-id", userId);
  return builder.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "https-security-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
}

async function saveCredential(
  fixture: { workspaceId: string; apiId: string },
  schemeName: string,
  secret: string,
  label = "test credential",
) {
  return request(app)
    .post(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/credentials`)
    .send({ schemeName, label, secret })
    .expect(200);
}

function listTools(workspaceId: string, userId?: string) {
  const builder = request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", "tools/list");
  if (userId) builder.set("x-test-user-id", userId);
  return builder.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "https-security-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

beforeAll(async () => {
  certificateDirectory = mkdtempSync(join(tmpdir(), "gateway-tls-fixture-"));
  const keyPath = join(certificateDirectory, "fixture-key.pem");
  const certificatePath = join(certificateDirectory, "fixture-cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${fixtureHostname}`,
    "-addext",
    `subjectAltName=DNS:${fixtureHostname}`,
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ], { stdio: "ignore" });
  certificate = readFileSync(certificatePath, "utf8");

  server = createServer({
    key: readFileSync(keyPath),
    cert: certificate,
  }, (req, res) => {
    receivedRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      host: req.headers.host ?? "",
    });
    receivedHeaders.push({ ...req.headers });

    if (
      req.url?.startsWith("/v1/items/42") ||
      req.url?.startsWith("/v1/auth-header") ||
      req.url?.startsWith("/v1/auth-query") ||
      req.url?.startsWith("/v1/auth-bearer")
    ) {
      res.writeHead(200, {
        "content-type": "application/json",
        etag: "\"fixture\"",
        "set-cookie": "must-not-leave-the-broker=true",
        "x-fixture-secret": "must-not-leave-the-broker",
      });
      res.write('{"id":"');
      setImmediate(() => {
        res.write('42","ok":');
        setImmediate(() => res.end("true}"));
      });
      return;
    }
    if (req.url === "/v1/redirect") {
      res.writeHead(302, { location: `${fixtureServerUrl}/v1/items/42` });
      res.end();
      return;
    }
    if (req.url === "/v1/credential-redirect") {
      res.writeHead(302, { location: `${fixtureServerUrl}/v1/items/42` });
      res.end();
      return;
    }
    if (req.url === "/v1/auth-401") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"invalid credential"}');
      return;
    }
    if (req.url === "/v1/auth-403") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"error":"forbidden credential"}');
      return;
    }
    if (req.url?.startsWith("/v1/reflect")) {
      const secret = req.headers.authorization?.replace(/^Bearer /, "") ??
        req.headers["x-api-key"] ??
        new URL(`https://${req.headers.host}${req.url}`).searchParams.get("api_key") ??
        "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reflected: secret }));
      return;
    }
    if (req.url === "/v1/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let index = 0; index < 17; index += 1) {
        res.write(Buffer.alloc(65_536, "x"));
      }
      res.end();
      return;
    }
    if (req.url === "/v1/slow") {
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"late":true}');
      }, 5_500);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("secureConnection", (socket) => {
    if (socket.servername) receivedServerNames.push(socket.servername);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  fixtureServerUrl = `https://${fixtureHostname}:${address.port}`;
});

afterEach(() => {
  securityServices.outboundRequestBroker = originalBroker;
  resolvedHosts = [];
  receivedRequests = [];
  receivedHeaders = [];
  receivedServerNames = [];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  rmSync(certificateDirectory, { recursive: true, force: true });
});

describe.sequential("real HTTPS MCP execution", () => {
  it("uses the pinned address, validates TLS, executes GET, streams a bounded response, and audits success", async () => {
    const fixture = await setupOperation({
      path: "/items/{id}",
      operationId: "getFixtureItem",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "verbose", in: "query", schema: { type: "boolean" } },
      ],
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);

    const listed = await request(app)
      .post(`/api/workspaces/${fixture.workspaceId}/mcp`)
      .set("accept", "application/json, text/event-stream")
      .set("mcp-protocol-version", "2026-07-28")
      .set("mcp-method", "tools/list")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "https-security-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })
      .expect(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name))
      .toContain(fixture.toolName);

    const response = await callTool(
      fixture.workspaceId,
      fixture.toolName,
      { id: "42", verbose: true },
    ).expect(200);

    expect(response.body.result.content[0].text).toBe('{"id":"42","ok":true}');
    expect(response.body.result.structuredContent).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: "\"fixture\"",
      },
    });
    expect(resolvedHosts).toEqual([fixtureHostname, fixtureHostname]);
    expect(receivedRequests).toEqual([{
      method: "GET",
      url: "/v1/items/42?verbose=true",
      host: new URL(fixtureServerUrl).host,
    }]);
    expect(receivedServerNames).toEqual([fixtureHostname]);

    const events = await eventTypes(fixture.workspaceId, fixture.operationId);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "execution.attempted",
      "outbound.validation_allowed",
      "execution.succeeded",
    ]));
  });

  it("executes configured header API keys and Bearer tokens for an approved member call", async () => {
    const headerFixture = await setupOperation({
      path: "/auth-header",
      operationId: "getHeaderCredential",
      securityScheme: { name: "headerKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    const bearerFixture = await setupOperation({
      path: "/auth-bearer",
      operationId: "getBearerCredential",
      securityScheme: { name: "bearerAuth", type: "bearer" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    await saveCredential(headerFixture, "headerKey", "header-secret");
    await saveCredential(bearerFixture, "bearerAuth", "bearer-secret");

    const memberId = `member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId: headerFixture.workspaceId,
      userId: memberId,
      role: "MEMBER",
    });
    await db.insert(workspaceMembershipsTable).values({
      workspaceId: bearerFixture.workspaceId,
      userId: memberId,
      role: "MEMBER",
    });

    const memberCreate = await request(app)
      .post(`/api/workspaces/${headerFixture.workspaceId}/apis/${headerFixture.apiId}/credentials`)
      .set("x-test-user-id", memberId)
      .send({ schemeName: "headerKey", label: "nope", secret: "member-secret" });
    expect(memberCreate.status).toBe(403);

    const headerResponse = await callTool(headerFixture.workspaceId, headerFixture.toolName, {}, memberId)
      .expect(200);
    expect(headerResponse.body.result.content[0].text).toBe('{"id":"42","ok":true}');
    expect(receivedHeaders.at(-1)?.["x-api-key"]).toBe("header-secret");
    expect(JSON.stringify(headerResponse.body)).not.toContain("header-secret");

    const bearerResponse = await callTool(bearerFixture.workspaceId, bearerFixture.toolName, {}, memberId)
      .expect(200);
    expect(bearerResponse.body.result.content[0].text).toBe('{"id":"42","ok":true}');
    expect(receivedHeaders.at(-1)?.authorization).toBe("Bearer bearer-secret");
    expect(JSON.stringify(bearerResponse.body)).not.toContain("bearer-secret");
  });

  it("executes a configured query API key and keeps it out of MCP and audit responses", async () => {
    const fixture = await setupOperation({
      path: "/auth-query",
      operationId: "getQueryCredential",
      securityScheme: { name: "queryKey", type: "apiKey", location: "query", parameterName: "api_key" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    await saveCredential(fixture, "queryKey", "query-secret");

    const response = await callTool(fixture.workspaceId, fixture.toolName).expect(200);
    expect(receivedRequests.at(-1)?.url).toBe("/v1/auth-query?api_key=query-secret");
    expect(response.body.result.content[0].text).toBe('{"id":"42","ok":true}');
    const rows = await auditRows(fixture.workspaceId, fixture.operationId);
    expect(JSON.stringify({ response: response.body, rows })).not.toContain("query-secret");
  });

  it("omits missing credentials from tools and denies their calls without secrets", async () => {
    const fixture = await setupOperation({
      path: "/missing-credential",
      operationId: "getMissingCredential",
      securityScheme: { name: "missingKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    const listed = await listTools(fixture.workspaceId).expect(200);
    expect(listed.body.result.tools).toEqual([]);

    const response = await callTool(fixture.workspaceId, fixture.toolName).expect(403);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|credential-value/i);
    const rows = await auditRows(fixture.workspaceId, fixture.operationId);
    expect(rows.map((row) => row.eventType)).toContain("execution.denied");
  });

  it("revokes credentials and removes the tool before denying the next call", async () => {
    const fixture = await setupOperation({
      path: "/revoked-credential",
      operationId: "getRevokedCredential",
      securityScheme: { name: "revokeKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    const configured = await saveCredential(fixture, "revokeKey", "revoke-secret");
    expect((await listTools(fixture.workspaceId)).body.result.tools).toHaveLength(1);
    await request(app)
      .delete(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/credentials/${configured.body.id}`)
      .expect(200);
    expect((await listTools(fixture.workspaceId)).body.result.tools).toEqual([]);
    const response = await callTool(fixture.workspaceId, fixture.toolName).expect(403);
    expect(JSON.stringify(response.body)).not.toContain("revoke-secret");
    const rows = await auditRows(fixture.workspaceId, fixture.operationId);
    expect(rows.map((row) => row.eventType)).toContain("execution.denied");
  });

  it("blocks credentialed redirects and suppresses upstream 401/403 bodies", async () => {
    for (const [path, operationId, expectedStatus, bodyText] of [
      ["/credential-redirect", "getCredentialRedirect", 502, ""] as const,
      ["/auth-401", "getCredential401", 502, "invalid credential"] as const,
      ["/auth-403", "getCredential403", 502, "forbidden credential"] as const,
    ]) {
      const fixture = await setupOperation({
        path,
        operationId,
        securityScheme: { name: "protectedKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
      });
      securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
      await saveCredential(fixture, "protectedKey", "protected-secret");
      const response = await callTool(fixture.workspaceId, fixture.toolName).expect(expectedStatus);
      expect(JSON.stringify(response.body)).not.toContain("protected-secret");
      if (bodyText) expect(JSON.stringify(response.body)).not.toContain(bodyText);
      const rows = await auditRows(fixture.workspaceId, fixture.operationId);
      expect(JSON.stringify(rows)).not.toContain("protected-secret");
      expect(rows.map((row) => row.eventType)).toEqual(expect.arrayContaining(
        path === "/credential-redirect"
          ? ["execution.denied"]
          : ["execution.credential_rejected"],
      ));
    }
  });

  it("fails closed when an upstream reflects a managed secret", async () => {
    const fixture = await setupOperation({
      path: "/reflect",
      operationId: "getReflectedCredential",
      securityScheme: { name: "reflectKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    await saveCredential(fixture, "reflectKey", "reflected-secret");
    const response = await callTool(fixture.workspaceId, fixture.toolName).expect(502);
    expect(JSON.stringify(response.body)).not.toContain("reflected-secret");
    const rows = await auditRows(fixture.workspaceId, fixture.operationId);
    expect(JSON.stringify(rows)).not.toContain("reflected-secret");
  });

  it("does not reuse a credential across APIs or workspaces", async () => {
    const source = await setupOperation({
      path: "/source",
      operationId: "getSourceCredential",
      securityScheme: { name: "isolatedKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    const other = await setupOperation({
      path: "/other",
      operationId: "getOtherCredential",
      securityScheme: { name: "isolatedKey", type: "apiKey", location: "header", parameterName: "X-API-Key" },
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);
    await saveCredential(source, "isolatedKey", "isolated-secret");
    const response = await callTool(other.workspaceId, other.toolName).expect(403);
    expect(JSON.stringify(response.body)).not.toContain("isolated-secret");
    expect((await listTools(other.workspaceId)).body.result.tools).toEqual([]);
  });

  it("rejects an untrusted certificate and audits the failure", async () => {
    const fixture = await setupOperation({
      path: "/items/{id}",
      operationId: "getUntrustedFixtureItem",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(false);

    await callTool(fixture.workspaceId, fixture.toolName, { id: "42" })
      .expect(502);
    expect(receivedRequests).toHaveLength(0);

    const events = await eventTypes(fixture.workspaceId, fixture.operationId);
    expect(events.map((event) => event.eventType)).toContain("execution.failed");
  });

  it("rejects a real upstream redirect and audits the denial", async () => {
    const fixture = await setupOperation({
      path: "/redirect",
      operationId: "getRedirect",
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);

    await callTool(fixture.workspaceId, fixture.toolName).expect(502);
    expect(receivedRequests.map((entry) => entry.url)).toEqual(["/v1/redirect"]);

    const events = await eventTypes(fixture.workspaceId, fixture.operationId);
    expect(events.map((event) => event.eventType)).toContain("execution.denied");
  });

  it("stops an oversized streaming response and audits the response limit", async () => {
    const fixture = await setupOperation({
      path: "/large",
      operationId: "getOversizedResponse",
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);

    await callTool(fixture.workspaceId, fixture.toolName).expect(502);

    const events = await eventTypes(fixture.workspaceId, fixture.operationId);
    expect(events.map((event) => event.eventType))
      .toContain("execution.response_limit_exceeded");
  });

  it("aborts a slow upstream request and audits the timeout", async () => {
    const fixture = await setupOperation({
      path: "/slow",
      operationId: "getSlowResponse",
    });
    securityServices.outboundRequestBroker = createLiveFixtureBroker(true);

    await callTool(fixture.workspaceId, fixture.toolName).expect(504);

    const events = await eventTypes(fixture.workspaceId, fixture.operationId);
    expect(events.map((event) => event.eventType)).toContain("execution.timed_out");
  }, 10_000);
});
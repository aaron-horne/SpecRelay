import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq, inArray } from "drizzle-orm";
import {
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  executionLeasesTable,
} from "@workspace/db";
import { mcpToolName } from "@workspace/mcp";
import {
  OutboundBrokerError,
} from "@workspace/security";
import app from "./app";
import { securityServices } from "./services/security";

const originalBroker = securityServices.outboundRequestBroker;
afterEach(() => {
  securityServices.outboundRequestBroker = originalBroker;
});

async function setup() {
  const workspace = await request(app).post("/api/workspaces")
    .send({ name: `Execution ${randomUUID()}` }).expect(201);
  const api = await request(app)
    .post(`/api/workspaces/${workspace.body.id}/apis`)
    .send({ name: "Fixture API" }).expect(201);
  const document = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Fixture", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/items/{id}": {
        get: {
          operationId: "getItem",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "verbose", in: "query", schema: { type: "boolean" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  const imported = await request(app)
    .post(`/api/workspaces/${workspace.body.id}/apis/${api.body.id}/specifications`)
    .send({ document }).expect(201);
  const operation = imported.body.operations[0];
  const toolName = mcpToolName({
    id: operation.id,
    operationId: operation.operationId,
    displayName: operation.displayName,
    description: operation.description,
    parameters: operation.parameters,
  });
  return {
    workspaceId: workspace.body.id as string,
    apiId: api.body.id as string,
    specificationId: imported.body.specification.id as string,
    operationId: operation.id as string,
    toolName,
  };
}

function replacementDocument(version: string) {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Fixture", version },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/replacement": {
        get: {
          operationId: "replacement",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

function mcp(workspaceId: string, method: string, params?: object) {
  const name = method === "tools/call" && params && "name" in params
    ? String(params.name)
    : undefined;
  const requestBuilder = request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method);
  if (name) requestBuilder.set("mcp-name", name);
  return requestBuilder.send({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "security-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

describe.sequential("first MCP execution milestone", () => {
  it("enforces modern request metadata and returns discovery and list cache metadata", async () => {
    const fixture = await setup();

    const discovery = await mcp(fixture.workspaceId, "server/discover").expect(200);
    expect(discovery.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "SpecRelay",
          version: "1.0.0",
        },
      },
    });

    const listed = await mcp(fixture.workspaceId, "tools/list").expect(200);
    expect(listed.body.result).toMatchObject({
      resultType: "complete",
      tools: [],
      ttlMs: 0,
      cacheScope: "private",
    });

    const mismatch = await request(app)
      .post(`/api/workspaces/${fixture.workspaceId}/mcp`)
      .set("mcp-protocol-version", "2026-07-28")
      .set("mcp-method", "tools/call")
      .send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })
      .expect(400);
    expect(mismatch.body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32020,
        message: "MCP request headers do not match the JSON-RPC body",
      },
    });

    const unknown = await mcp(fixture.workspaceId, "resources/list").expect(404);
    expect(unknown.body.error).toMatchObject({
      code: -32601,
      message: "Method not found",
    });
  });

  it("imports denied, requires approval, discovers a tool, executes it, and audits the flow", async () => {
    const fixture = await setup();
    const before = await mcp(fixture.workspaceId, "tools/list").expect(200);
    expect(before.body.result.tools).toEqual([]);

    await mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName,
      arguments: { id: "42" },
    }).expect(403);

    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true })
      .expect(200);

    let requestedUrl = "";
    securityServices.outboundRequestBroker = {
      async validate() {
        throw new Error("validate is performed by execute");
      },
      async execute(candidate) {
        requestedUrl = candidate.destination.href;
        expect(candidate.method).toBe("GET");
        expect(candidate.body).toBeUndefined();
        expect(candidate.credentialReference).toBeUndefined();
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"id":"42","ok":true}'),
        };
      },
    };

    const discovered = await mcp(fixture.workspaceId, "tools/list").expect(200);
    expect(discovered.body.result.tools).toHaveLength(1);
    expect(discovered.body.result.tools[0].name).toBe(fixture.toolName);

    const called = await mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName,
      arguments: { id: "42", verbose: true },
    }).expect(200);
    expect(requestedUrl).toBe("https://api.example.com/v1/items/42?verbose=true");
    expect(called.body.result.content[0].text).toBe('{"id":"42","ok":true}');

    const events = await db.select({ eventType: auditEventsTable.eventType })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, fixture.workspaceId),
        eq(auditEventsTable.resourceId, fixture.operationId),
      ));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "execution.attempted",
      "execution.denied",
      "operation.enabled",
      "execution.succeeded",
    ]));
  });

  it("audits broker failures, timeouts, and response-limit violations", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true })
      .expect(200);

    const cases = [
      ["VALIDATION_DENIED", 502],
      ["TIMEOUT", 504],
      ["RESPONSE_LIMIT", 502],
      ["UPSTREAM_FAILURE", 502],
    ] as const;
    for (const [code, status] of cases) {
      securityServices.outboundRequestBroker = {
        async validate() { throw new Error("unused"); },
        async execute() { throw new OutboundBrokerError(code, code); },
      };
      await mcp(fixture.workspaceId, "tools/call", {
        name: fixture.toolName,
        arguments: { id: "42" },
      }).expect(status);
    }

    const events = await db.select({ eventType: auditEventsTable.eventType })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, fixture.workspaceId),
        eq(auditEventsTable.resourceId, fixture.operationId),
        inArray(auditEventsTable.eventType, [
          "execution.denied",
          "execution.timed_out",
          "execution.response_limit_exceeded",
          "execution.failed",
        ]),
      ));
    expect(new Set(events.map((event) => event.eventType))).toEqual(new Set([
      "execution.denied",
      "execution.timed_out",
      "execution.response_limit_exceeded",
      "execution.failed",
    ]));
  });

  it("works end to end through the official MCP TypeScript SDK client", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true })
      .expect(200);

    securityServices.outboundRequestBroker = {
      async validate() {
        throw new Error("validate is performed by execute");
      },
      async execute(candidate) {
        expect(candidate.destination.href).toBe("https://api.example.com/v1/items/42");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"id":"42","sdk":true}'),
        };
      },
    };

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new Client(
      { name: "official-sdk-compatibility-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/api/workspaces/${fixture.workspaceId}/mcp`),
        { requestInit: { headers: { "x-test-user-id": "security-test-user" } } },
      ));
      expect(client.getProtocolEra()).toBe("modern");

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain(fixture.toolName);

      const called = await client.callTool({
        name: fixture.toolName,
        arguments: { id: "42" },
      });
      expect(called.isError).toBe(false);
      expect(called.content).toContainEqual({
        type: "text",
        text: '{"id":"42","sdk":true}',
      });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }

    const events = await db.select({ eventType: auditEventsTable.eventType })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, fixture.workspaceId),
        eq(auditEventsTable.resourceId, fixture.operationId),
      ));
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "execution.attempted",
      "execution.succeeded",
    ]));
  });

  it("marks completed upstream HTTP errors as tool and audit errors", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true })
      .expect(200);

    securityServices.outboundRequestBroker = {
      async validate() {
        throw new Error("validate is performed by execute");
      },
      async execute() {
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"error":"unavailable"}'),
        };
      },
    };

    const response = await mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName,
      arguments: { id: "42" },
    }).expect(200);
    expect(response.body.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { status: 503 },
    });

    const events = await db.select({ eventType: auditEventsTable.eventType })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, fixture.workspaceId),
        eq(auditEventsTable.resourceId, fixture.operationId),
      ));
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toContain("execution.upstream_http_error");
    expect(eventTypes).not.toContain("execution.succeeded");
  });

  it("holds a workspace/source/spec/operation lease during dispatch and releases it", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true }).expect(200);

    let releaseBroker!: () => void;
    const brokerReady = new Promise<void>((resolve) => { releaseBroker = resolve; });
    securityServices.outboundRequestBroker = {
      async validate() { throw new Error("unused"); },
      async execute() {
        await brokerReady;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    };
    await db.insert(executionLeasesTable).values({
      workspaceId: fixture.workspaceId,
      apiId: fixture.apiId,
      specificationId: fixture.specificationId,
      operationId: fixture.operationId,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const call = mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName, arguments: { id: "42" },
    }).expect(200).then(() => undefined);
    for (let attempt = 0; attempt < 20; attempt++) {
      const leases = await db.select().from(executionLeasesTable)
        .where(eq(executionLeasesTable.operationId, fixture.operationId));
      if (leases.length > 0) {
        expect(leases[0]).toMatchObject({
          workspaceId: fixture.workspaceId,
          apiId: fixture.apiId,
          specificationId: fixture.specificationId,
          operationId: fixture.operationId,
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const held = await db.select().from(executionLeasesTable)
      .where(eq(executionLeasesTable.operationId, fixture.operationId));
    expect(held).toHaveLength(1);
    releaseBroker();
    await call;
    expect(await db.select().from(executionLeasesTable)
      .where(eq(executionLeasesTable.operationId, fixture.operationId))).toHaveLength(0);
  });

  it("cleans up leases after broker failure and timeout", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true }).expect(200);
    for (const code of ["UPSTREAM_FAILURE", "TIMEOUT"] as const) {
      securityServices.outboundRequestBroker = {
        async validate() { throw new Error("unused"); },
        async execute() { throw new OutboundBrokerError(code, code); },
      };
      await mcp(fixture.workspaceId, "tools/call", {
        name: fixture.toolName, arguments: { id: "42" },
      }).expect(code === "TIMEOUT" ? 504 : 502);
      expect(await db.select().from(executionLeasesTable)
        .where(eq(executionLeasesTable.operationId, fixture.operationId))).toHaveLength(0);
    }
  });

  it("prevents replacement while leased, then allows it and rejects the stale operation", async () => {
    const fixture = await setup();
    await request(app)
      .patch(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/operations/${fixture.operationId}`)
      .send({ enabled: true }).expect(200);
    let releaseBroker!: () => void;
    const brokerReady = new Promise<void>((resolve) => { releaseBroker = resolve; });
    securityServices.outboundRequestBroker = {
      async validate() { throw new Error("unused"); },
      async execute() {
        await brokerReady;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    };
    const call = mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName, arguments: { id: "42" },
    }).expect(200).then(() => undefined);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await db.select({ id: executionLeasesTable.id }).from(executionLeasesTable)
        .where(eq(executionLeasesTable.operationId, fixture.operationId))).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const blocked = await request(app)
      .post(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/specifications`)
      .send({ document: replacementDocument("2.0.0") }).expect(409);
    expect(blocked.body.code).toBe("SPECIFICATION_IMPORT_BUSY");
    const latestWhileHeld = await db.select({ id: apiSpecVersionsTable.id })
      .from(apiSpecVersionsTable)
      .where(eq(apiSpecVersionsTable.apiId, fixture.apiId))
      .orderBy(apiSpecVersionsTable.importedAt);
    expect(latestWhileHeld.at(-1)?.id).toBe(fixture.specificationId);

    releaseBroker();
    await call;
    const replaced = await request(app)
      .post(`/api/workspaces/${fixture.workspaceId}/apis/${fixture.apiId}/specifications`)
      .send({ document: replacementDocument("2.0.0") }).expect(201);
    expect(replaced.body.specification.id).not.toBe(fixture.specificationId);
    await mcp(fixture.workspaceId, "tools/call", {
      name: fixture.toolName, arguments: { id: "42" },
    }).expect(404);
  });
});
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { auditEventsTable, connectorTokensTable, db, workspaceMembershipsTable } from "@workspace/db";
import app from "./app";
import { limit, verifyConnector } from "./services/connector-tokens";
import { securityServices } from "./services/security";
import { mcpToolName } from "@workspace/mcp";
import { McpService } from "./services/execution";

const previousFlag = process.env.CONNECTOR_TOKENS_ENABLED;
const originalBroker = securityServices.outboundRequestBroker;
beforeAll(() => { process.env.CONNECTOR_TOKENS_ENABLED = "true" });
afterEach(() => { securityServices.outboundRequestBroker = originalBroker });
afterAll(() => {
  if (previousFlag === undefined) delete process.env.CONNECTOR_TOKENS_ENABLED;
  else process.env.CONNECTOR_TOKENS_ENABLED = previousFlag;
});
const owner = `connector-owner-${randomUUID()}`;
const other = `connector-other-${randomUUID()}`;

function mcp(workspace: string, token: string, method: string, name = "not-a-tool") {
  const builder = request(app).post(`/api/workspaces/${workspace}/mcp`)
    .set("authorization", `Bearer ${token}`)
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method);
  if (method === "tools/call") builder.set("mcp-name", name);
  return builder.send({ jsonrpc: "2.0", id: 1, method, params: { ...(method === "tools/call" ? { name, arguments: {} } : {}), _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    } } });
}

describe.sequential("connector-token isolation and secret safety", () => {
  it("bounds authentication and actor windows without storing a raw token in the limit key", () => {
    const key = `test:${randomUUID()}`;
    expect(limit(key, 2)).toBe(true);
    expect(limit(key, 2)).toBe(true);
    expect(limit(key, 2)).toBe(false);
  });
  it("only OWNER issues, rotates and revokes; tokens remain scoped and never reappear", async () => {
    const a = (await request(app).post("/api/workspaces").set("x-test-user-id", owner).send({ name: "Connector A" }).expect(201)).body.id as string;
    const b = (await request(app).post("/api/workspaces").set("x-test-user-id", other).send({ name: "Connector B" }).expect(201)).body.id as string;
    await db.insert(workspaceMembershipsTable).values({ workspaceId: a, userId: other, role: "MEMBER" });
    await request(app).post(`/api/workspaces/${a}/connectors`).set("x-test-user-id", other)
      .send({ name: "blocked", scopes: ["tools:call"] }).expect(403);
    await request(app).get(`/api/workspaces/${b}/connectors`).set("x-test-user-id", owner).expect(404);
    const created = await request(app).post(`/api/workspaces/${a}/connectors`).set("x-test-user-id", owner)
      .send({ name: "Reports", scopes: ["tools:list"] }).expect(201);
    const { token, actorId } = created.body as { token: string; actorId: string };
    expect(token).toMatch(/^srct_/);
    const list = await request(app).get(`/api/workspaces/${a}/connectors`).set("x-test-user-id", owner).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain(token.split("_")[1]);
    const [stored] = await db.select().from(connectorTokensTable).where(eq(connectorTokensTable.actorId, actorId));
    expect(stored.verifier).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await verifyConnector(token)).toMatchObject({ workspaceId: a, actorId });
    await mcp(b, token, "tools/list").expect(404);
    await mcp(a, token + "x", "tools/list").expect(401);
    await mcp(a, token, "tools/list").expect(200);
    await mcp(a, token, "tools/call").expect(403);
    const ambiguous = mcp(a, token, "tools/list").set("cookie", "session=human").set("x-test-user-id", owner);
    await ambiguous.expect(401);
    await request(app).get(`/api/workspaces/${a}`).set("authorization", `Bearer ${token}`).set("x-test-user-id", "__unauthenticated__").expect(401);
    const rotated = await request(app).post(`/api/workspaces/${a}/connectors/${actorId}/rotate`).set("x-test-user-id", owner).expect(200);
    const replacement = rotated.body.token as string;
    expect(replacement).not.toBe(token);
    await mcp(a, token, "tools/list").expect(200);
    await mcp(a, replacement, "tools/list").expect(200);
    const metadata = await request(app).get(`/api/workspaces/${a}/connectors`).set("x-test-user-id", owner).expect(200);
    expect(JSON.stringify(metadata.body)).not.toContain(replacement);
    await request(app).delete(`/api/workspaces/${a}/connectors/${actorId}`).set("x-test-user-id", other).expect(403);
    await request(app).delete(`/api/workspaces/${a}/connectors/${actorId}`).set("x-test-user-id", owner).expect(200);
    await mcp(a, token, "tools/list").expect(401);
    await mcp(a, replacement, "tools/list").expect(401);
    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.workspaceId, a));
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(replacement);
    expect(events.some(e => e.eventType === "execution.denied")).toBe(true);
    const logs = await request(app).get(`/api/execution-logs?workspaceId=${a}`).set("x-test-user-id", owner).expect(200);
    expect(JSON.stringify(logs.body)).not.toContain(token);
    expect(JSON.stringify(logs.body)).not.toContain(replacement);
    expect(logs.body.items[0].actorLabel).toBe("Connector: Reports");
    // Missing MEMBER linkage must fail even when an unexpired hash matches.
    const another = await request(app).post(`/api/workspaces/${a}/connectors`).set("x-test-user-id", owner)
      .send({ name: "No membership", scopes: ["tools:list"] }).expect(201);
    const identity = await verifyConnector(another.body.token as string);
    await db.delete(workspaceMembershipsTable).where(and(eq(workspaceMembershipsTable.workspaceId, a), eq(workspaceMembershipsTable.userId, identity!.memberId)));
    await mcp(a, another.body.token as string, "tools/list").expect(401);
    process.env.CONNECTOR_TOKENS_ENABLED = "false";
    await mcp(a, another.body.token as string, "tools/list").expect(401);
    await request(app).get(`/api/workspaces/${a}/connectors`).set("x-test-user-id", owner).expect(404);
    process.env.CONNECTOR_TOKENS_ENABLED = "true";
  });
  it("rechecks approval and token at dispatch, never forwards inbound credentials, and fails after expiry", async () => {
    process.env.CONNECTOR_TOKENS_ENABLED = "true";
    const workspaceId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner).send({ name: "Connector execution" }).expect(201)).body.id as string;
    const apiId = (await request(app).post(`/api/workspaces/${workspaceId}/apis`).set("x-test-user-id", owner).send({ name: "Safe API" }).expect(201)).body.id as string;
    const imported = await request(app).post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`).set("x-test-user-id", owner)
      .send({ document: JSON.stringify({ openapi: "3.1.0", info: { title: "Safe", version: "1" }, servers: [{ url: "https://api.example.test" }],
        paths: { "/items": { get: { operationId: "listItems", responses: { "200": { description: "ok" } } } } } }) }).expect(201);
    const operation = imported.body.operations[0];
    const name = mcpToolName(operation);
    const issued = await request(app).post(`/api/workspaces/${workspaceId}/connectors`).set("x-test-user-id", owner)
      .send({ name: "Call agent", scopes: ["tools:list", "tools:call"] }).expect(201);
    const { token, actorId } = issued.body as { token: string; actorId: string };
    expect((await mcp(workspaceId, token, "tools/list").expect(200)).body.result.tools).toHaveLength(0);
    let dispatches = 0;
    securityServices.outboundRequestBroker = {
      async validate() { throw new Error("unused"); },
      async execute(candidate) {
        dispatches++;
        expect(candidate.method).toBe("GET");
        expect(candidate.body).toBeUndefined();
        expect(JSON.stringify(candidate)).not.toContain(token);
        return { status: 200, headers: {}, body: new TextEncoder().encode("safe") };
      },
    };
    await mcp(workspaceId, token, "tools/call", name).expect(403);
    expect(dispatches).toBe(0);
    await request(app).patch(`/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operation.id}`).set("x-test-user-id", owner)
      .send({ enabled: true }).expect(200);
    expect((await mcp(workspaceId, token, "tools/list").expect(200)).body.result.tools).toHaveLength(1);
    await mcp(workspaceId, token, "tools/call", name).expect(200);
    expect(dispatches).toBe(1);
    await expect(new McpService().callTool(workspaceId, (await verifyConnector(token))!.memberId, name, {}, async () => false))
      .rejects.toMatchObject({ code: "EXECUTION_DENIED" });
    expect(dispatches).toBe(1);
    for (let i = 0; i < 120; i++) limit(`actor:${workspaceId}:${actorId}`, 120);
    await mcp(workspaceId, token, "tools/list").expect(429);
    expect(dispatches).toBe(1);
    await db.update(connectorTokensTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(connectorTokensTable.actorId, actorId));
    await mcp(workspaceId, token, "tools/call", name).expect(401);
    expect(dispatches).toBe(1);
    const logs = await request(app).get(`/api/execution-logs?workspaceId=${workspaceId}`).set("x-test-user-id", owner).expect(200);
    expect(logs.body.items.some((item: { actorLabel: string }) => item.actorLabel === "Connector: Call agent")).toBe(true);
    expect(JSON.stringify(logs.body)).not.toContain(token);
  });
});
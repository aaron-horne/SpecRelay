import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  apiOperationsTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  executionLeasesTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import { mcpToolName } from "@workspace/mcp";
import app from "./app";

const ownerA = `tenant-owner-a-${randomUUID()}`;
const ownerB = `tenant-owner-b-${randomUUID()}`;
const memberA = `tenant-member-a-${randomUUID()}`;

function auth(userId: string) {
  return { "x-test-user-id": userId };
}

async function createWorkspace(userId: string, name: string): Promise<string> {
  const response = await request(app)
    .post("/api/workspaces")
    .set(auth(userId))
    .send({ name })
    .expect(201);
  return response.body.id as string;
}

async function createApi(userId: string, workspaceId: string): Promise<string> {
  const response = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis`)
    .set(auth(userId))
    .send({ name: `Tenant API ${randomUUID()}` })
    .expect(201);
  return response.body.id as string;
}

function document() {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Tenant isolation API", version: "1.0.0" },
    servers: [{ url: "https://tenant.example.test/v1" }],
    components: {
      securitySchemes: {
        tenantKey: { type: "apiKey", in: "header", name: "X-Tenant-Key" },
      },
    },
    security: [{ tenantKey: [] }],
    paths: {
      "/records": {
        get: {
          operationId: "listRecords",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

function mcp(workspaceId: string, userId: string, method: string, params: Record<string, unknown> = {}) {
  const name = method === "tools/call" && typeof params.name === "string"
    ? params.name
    : undefined;
  return request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set(auth(userId))
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method)
    .set(name ? "mcp-name" : "x-unused-header", name ?? "")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "tenant-isolation-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
}

describe.sequential("two-tenant IDOR and authorization isolation", () => {
  it("isolates every protected resource while preserving owner/member permissions", async () => {
    const workspaceA = await createWorkspace(ownerA, `Tenant A ${randomUUID()}`);
    const workspaceB = await createWorkspace(ownerB, `Tenant B ${randomUUID()}`);
    const apiA = await createApi(ownerA, workspaceA);
    await db.insert(workspaceMembershipsTable).values({
      workspaceId: workspaceA,
      userId: memberA,
      role: "MEMBER",
    });

    const imported = await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiA}/specifications`)
      .set(auth(ownerA))
      .send({ document: document() })
      .expect(201);
    const specificationId = imported.body.specification.id as string;
    const operationId = imported.body.operations[0].id as string;
    const toolName = mcpToolName(imported.body.operations[0]);

    const configured = await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`)
      .set(auth(ownerA))
      .send({ schemeName: "tenantKey", label: "primary", secret: "tenant-a-secret" })
      .expect(200);
    const credentialId = configured.body.id as string;
    expect(JSON.stringify(configured.body)).not.toContain("tenant-a-secret");

    await request(app)
      .patch(`/api/workspaces/${workspaceA}/apis/${apiA}/operations/${operationId}`)
      .set(auth(ownerA))
      .send({ enabled: true })
      .expect(200);

    for (const userId of [ownerA, memberA]) {
      const detail = await request(app)
        .get(`/api/workspaces/${workspaceA}/apis/${apiA}`)
        .set(auth(userId))
        .expect(200);
      expect(detail.body.api.id).toBe(apiA);
      expect(detail.body.api.latestSpecification.id).toBe(specificationId);
      expect(detail.body.operations.map((operation: { id: string }) => operation.id)).toContain(operationId);

      const credentials = await request(app)
        .get(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`)
        .set(auth(userId))
        .expect(200);
      expect(credentials.body).toHaveLength(1);
      expect(JSON.stringify(credentials.body)).not.toMatch(
        /tenant-a-secret|secretCiphertext|secretIv|secretAuthTag|ciphertext|authTag/i,
      );
    }

    await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`)
      .set(auth(memberA))
      .send({ schemeName: "tenantKey", label: "member-replace", secret: "member-secret" })
      .expect(403);
    await request(app)
      .delete(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials/${credentialId}`)
      .set(auth(memberA))
      .expect(403);
    await request(app)
      .patch(`/api/workspaces/${workspaceA}/apis/${apiA}/operations/${operationId}`)
      .set(auth(memberA))
      .send({ enabled: false })
      .expect(403);

    const beforeDeniedAudit = await db
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, workspaceA),
        eq(auditEventsTable.resourceId, operationId),
      ));
    const beforeDeniedLeases = await db
      .select({ id: executionLeasesTable.id })
      .from(executionLeasesTable)
      .where(eq(executionLeasesTable.operationId, operationId));

    const protectedResourceRequests = [
      request(app).get(`/api/workspaces/${workspaceA}`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/overview`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/apis`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/apis/${apiA}`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/apis/${apiA}/operations`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/apis/${apiA}/operations/${operationId}`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`).set(auth(ownerB)),
      request(app).post(`/api/workspaces/${workspaceA}/apis`).set(auth(ownerB))
        .send({ name: "cross-tenant API" }),
      request(app).post(`/api/workspaces/${workspaceA}/apis/${apiA}/specifications`).set(auth(ownerB))
        .send({ document: document() }),
      request(app).patch(`/api/workspaces/${workspaceA}/apis/${apiA}/operations/${operationId}`).set(auth(ownerB))
        .send({ enabled: false }),
      request(app).post(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`).set(auth(ownerB))
        .send({ schemeName: "tenantKey", label: "cross-tenant", secret: "cross-tenant-secret" }),
      request(app).delete(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials/${credentialId}`).set(auth(ownerB)),
    ];
    for (const response of await Promise.all(protectedResourceRequests)) {
      expect(response.status).toBe(404);
    }

    const listedForB = await mcp(workspaceA, ownerB, "tools/list").expect(404);
    expect(listedForB.body.code).toBe("WORKSPACE_NOT_FOUND");
    const calledForB = await mcp(workspaceA, ownerB, "tools/call", {
      name: toolName,
      arguments: {},
    }).expect(404);
    expect(calledForB.body.code).toBe("WORKSPACE_NOT_FOUND");

    const afterDeniedAudit = await db
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(and(
        eq(auditEventsTable.workspaceId, workspaceA),
        eq(auditEventsTable.resourceId, operationId),
      ));
    const afterDeniedLeases = await db
      .select({ id: executionLeasesTable.id })
      .from(executionLeasesTable)
      .where(eq(executionLeasesTable.operationId, operationId));
    expect(afterDeniedAudit).toHaveLength(beforeDeniedAudit.length);
    expect(afterDeniedLeases).toHaveLength(beforeDeniedLeases.length);

    const mixedResourceRequests = [
      request(app).get(`/api/workspaces/${workspaceB}/apis/${apiA}`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceB}/apis/${apiA}/operations/${operationId}`).set(auth(ownerB)),
      request(app).get(`/api/workspaces/${workspaceB}/apis/${apiA}/credentials`).set(auth(ownerB)),
      request(app).post(`/api/workspaces/${workspaceB}/apis/${apiA}/specifications`).set(auth(ownerB))
        .send({ document: document() }),
      request(app).patch(`/api/workspaces/${workspaceB}/apis/${apiA}/operations/${operationId}`).set(auth(ownerB))
        .send({ enabled: false }),
      request(app).delete(`/api/workspaces/${workspaceB}/apis/${apiA}/credentials/${credentialId}`).set(auth(ownerB)),
    ];
    for (const response of await Promise.all(mixedResourceRequests)) {
      expect(response.status).toBe(404);
    }

    const bWorkspace = await request(app)
      .get(`/api/workspaces/${workspaceB}`)
      .set(auth(ownerB))
      .expect(200);
    expect(bWorkspace.body.id).toBe(workspaceB);
    await request(app).get(`/api/workspaces/${workspaceA}`).set(auth(memberA)).expect(200);

    const replaced = await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials`)
      .set(auth(ownerA))
      .send({ schemeName: "tenantKey", label: "rotated", secret: "tenant-a-secret-rotated" })
      .expect(200);
    expect(replaced.body.id).toBe(credentialId);
    expect(JSON.stringify(replaced.body)).not.toContain("tenant-a-secret-rotated");
    await request(app)
      .delete(`/api/workspaces/${workspaceA}/apis/${apiA}/credentials/${credentialId}`)
      .set(auth(ownerA))
      .expect(200);

    const stored = await db
      .select({
        workspaceId: apiSpecVersionsTable.workspaceId,
        specificationId: apiOperationsTable.specificationId,
      })
      .from(apiOperationsTable)
      .innerJoin(apiSpecVersionsTable, eq(apiSpecVersionsTable.id, apiOperationsTable.specificationId))
      .where(eq(apiOperationsTable.id, operationId));
    expect(stored[0]).toMatchObject({ workspaceId: workspaceA, specificationId });
  });
});
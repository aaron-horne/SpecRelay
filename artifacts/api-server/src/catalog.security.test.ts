import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  auditEventsTable,
  apiSpecVersionsTable,
  db,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";

async function createWorkspace(name: string): Promise<string> {
  const response = await request(app)
    .post("/api/workspaces")
    .send({ name })
    .expect(201);
  const id = response.body.id as string;
  return id;
}

async function createApi(workspaceId: string): Promise<string> {
  const response = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis`)
    .send({ name: `Security test ${randomUUID()}` })
    .expect(201);
  return response.body.id as string;
}

describe.sequential("V0.1 HTTP security boundaries", () => {
  it("requires authentication and enforces workspace membership", async () => {
    await request(app)
      .get("/api/workspaces")
      .set("x-test-user-id", "__unauthenticated__")
      .expect(401);

    const workspaceId = await createWorkspace(`Membership ${randomUUID()}`);
    await request(app)
      .get(`/api/workspaces/${workspaceId}`)
      .set("x-test-user-id", "different-user")
      .expect(404);

    await request(app)
      .get(`/api/workspaces/${workspaceId}/apis`)
      .set("x-test-user-id", "different-user")
      .expect(404);
  });
  it("isolates API sources and operations by workspace", async () => {
    const workspaceA = await createWorkspace(`Workspace A ${randomUUID()}`);
    const workspaceB = await createWorkspace(`Workspace B ${randomUUID()}`);
    const apiId = await createApi(workspaceA);

    await expect(
      db.insert(apiSpecVersionsTable).values({
        workspaceId: workspaceB,
        apiId,
        version: "invalid-tenant-link",
        format: "json",
        openapiVersion: "3.1.0",
        documentHash: randomUUID(),
        rawDocument: "{}",
        normalizedDocument: {},
        serverUrls: [],
        validationWarnings: [],
      }),
    ).rejects.toThrow();

    await request(app)
      .get(`/api/workspaces/${workspaceB}/apis/${apiId}`)
      .expect(404);

    const document = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Isolation API", version: "1.0.0" },
      paths: {
        "/records": {
          get: {
            summary: "<script>alert('stored-xss')</script>",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    const importResponse = await request(app)
      .post(`/api/workspaces/${workspaceA}/apis/${apiId}/specifications`)
      .send({ document, filename: "isolation.json" })
      .expect(201);

    expect(importResponse.body.operations).toHaveLength(1);
    expect(importResponse.body.operations[0]).toMatchObject({
      enabled: false,
      risk: "READ_LIKE",
      summary: "<script>alert('stored-xss')</script>",
    });

    const operationId = importResponse.body.operations[0].id as string;
    await request(app)
      .get(
        `/api/workspaces/${workspaceB}/apis/${apiId}/operations/${operationId}`,
      )
      .expect(404);

    await request(app)
      .patch(
        `/api/workspaces/${workspaceB}/apis/${apiId}/operations/${operationId}`,
      )
      .send({ enabled: true })
      .expect(404);
  });

  it("rejects attempts to override ownership and unexpected fields", async () => {
    const workspaceId = await createWorkspace(
      `Ownership test ${randomUUID()}`,
    );

    await request(app)
      .post(`/api/workspaces/${workspaceId}/apis`)
      .send({
        name: "Ownership API",
        workspaceId: randomUUID(),
      })
      .expect(400);

    await request(app)
      .post("/api/workspaces")
      .send({ name: "Unexpected", administrator: true })
      .expect(400);
  });

  it("persists disabled-by-default state changes and append-only audit events", async () => {
    const workspaceId = await createWorkspace(`Audit test ${randomUUID()}`);
    const apiId = await createApi(workspaceId);
    const importResponse = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Audit API", version: "1.0.0" },
          paths: {
            "/items": {
              delete: {
                operationId: "deleteItem",
                responses: { "204": { description: "deleted" } },
              },
            },
          },
        }),
      })
      .expect(201);

    const operation = importResponse.body.operations[0] as {
      id: string;
      enabled: boolean;
      risk: string;
    };
    expect(operation).toMatchObject({
      enabled: false,
      risk: "DESTRUCTIVE",
    });

    const enabledResponse = await request(app)
      .patch(
        `/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operation.id}`,
      )
      .send({ enabled: true })
      .expect(200);
    expect(enabledResponse.body.enabled).toBe(true);

    const persisted = await request(app)
      .get(
        `/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operation.id}`,
      )
      .expect(200);
    expect(persisted.body.enabled).toBe(true);

    const events = await db
      .select({ eventType: auditEventsTable.eventType })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.workspaceId, workspaceId));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "workspace.created",
        "api.created",
        "specification.imported",
        "operation.enabled",
      ]),
    );

    await expect(
      db
        .update(auditEventsTable)
        .set({ eventType: "tampered" })
        .where(eq(auditEventsTable.workspaceId, workspaceId)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(auditEventsTable)
        .where(eq(auditEventsTable.workspaceId, workspaceId)),
    ).rejects.toThrow();

    await request(app)
      .patch(`/api/audit-events/${randomUUID()}`)
      .send({ metadata: {} })
      .expect(404);
    await request(app)
      .delete(`/api/audit-events/${randomUUID()}`)
      .expect(404);
  });

  it("allows members to view catalog data but keeps operation approval owner-managed", async () => {
    const workspaceId = await createWorkspace(`Approval roles ${randomUUID()}`);
    const apiId = await createApi(workspaceId);
    const memberId = `member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId,
      userId: memberId,
      role: "MEMBER",
    });
    const imported = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Approval roles", version: "1.0.0" },
          paths: {
            "/items": {
              get: { responses: { "200": { description: "ok" } } },
            },
          },
        }),
      })
      .expect(201);
    const operationId = imported.body.operations[0].id as string;

    await request(app)
      .get(`/api/workspaces/${workspaceId}/apis/${apiId}`)
      .set("x-test-user-id", memberId)
      .expect(200);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/apis`)
      .set("x-test-user-id", memberId)
      .send({ name: "Member API" })
      .expect(403);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .set("x-test-user-id", memberId)
      .send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Member import", version: "1.0.0" },
          paths: {},
        }),
      })
      .expect(403);
    const denied = await request(app)
      .patch(`/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operationId}`)
      .set("x-test-user-id", memberId)
      .send({ enabled: true })
      .expect(403);
    expect(denied.body).toMatchObject({
      code: "OWNER_REQUIRED",
    });

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operationId}`)
      .send({ enabled: true })
      .expect(200);
  });

  it("blocks remote references and provides no arbitrary fetch route", async () => {
    const workspaceId = await createWorkspace(`Boundary test ${randomUUID()}`);
    const apiId = await createApi(workspaceId);

    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Remote ref API", version: "1.0.0" },
          paths: {},
          components: {
            schemas: {
              Secret: { $ref: "http://169.254.169.254/latest/meta-data" },
            },
          },
        }),
      })
      .expect(400);
    expect(response.body.code).toBe("REMOTE_REFERENCE_BLOCKED");

    await request(app)
      .post("/api/proxy")
      .send({ url: "http://127.0.0.1" })
      .expect(404);
    await request(app)
      .post("/api/execute")
      .send({ url: "https://example.com" })
      .expect(404);
  });

  it("returns sanitized errors for malformed JSON", async () => {
    const response = await request(app)
      .post("/api/workspaces")
      .set("Content-Type", "application/json")
      .send('{"name":')
      .expect(400);
    expect(response.body).toEqual({
      error: "Malformed JSON",
      code: "MALFORMED_JSON",
    });
    expect(JSON.stringify(response.body)).not.toContain("node_modules");
  });

  it("keeps immutable specification versions paired with their own operations", async () => {
    const workspaceId = await createWorkspace(`History test ${randomUUID()}`);
    const apiId = await createApi(workspaceId);
    const documentA = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "History API", version: "1.0.0" },
      paths: {
        "/version-a": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    const documentB = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "History API", version: "2.0.0" },
      paths: {
        "/version-b": {
          post: { responses: { "201": { description: "created" } } },
        },
      },
    });

    const firstImport = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({ document: documentA })
      .expect(201);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({ document: documentB })
      .expect(201);
    const repeatedImport = await request(app)
      .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .send({ document: documentA })
      .expect(201);

    expect(repeatedImport.body.specification.id).toBe(
      firstImport.body.specification.id,
    );
    expect(repeatedImport.body.operations).toHaveLength(1);
    expect(repeatedImport.body.operations[0].path).toBe("/version-a");

    const currentOperations = await request(app)
      .get(`/api/workspaces/${workspaceId}/apis/${apiId}/operations`)
      .expect(200);
    expect(currentOperations.body).toHaveLength(1);
    expect(currentOperations.body[0].path).toBe("/version-b");
  });
});
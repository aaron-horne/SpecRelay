import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { auditEventsTable, db } from "@workspace/db";
import app from "./app";

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

async function createOperation(
  userId: string,
  workspaceId: string,
  apiName: string,
): Promise<{ apiId: string; operationId: string }> {
  const apiResponse = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis`)
    .set(auth(userId))
    .send({ name: apiName })
    .expect(201);
  const apiId = apiResponse.body.id as string;
  const importResponse = await request(app)
    .post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
    .set(auth(userId))
    .send({
      document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: apiName, version: "1.0.0" },
        servers: [{ url: "https://logs.example.test" }],
        paths: {
          "/records": {
            get: {
              operationId: "listRecords",
              summary: "List records",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    })
    .expect(201);
  return {
    apiId,
    operationId: importResponse.body.operations[0].id as string,
  };
}

describe.sequential("execution logs read isolation", () => {
  it("returns only bounded, sanitized execution events from accessible workspaces", async () => {
    const ownerA = `execution-log-owner-a-${randomUUID()}`;
    const ownerB = `execution-log-owner-b-${randomUUID()}`;
    const workspaceA = await createWorkspace(ownerA, `Execution A ${randomUUID()}`);
    const workspaceB = await createWorkspace(ownerB, `Execution B ${randomUUID()}`);
    const operationA = await createOperation(ownerA, workspaceA, `Records A ${randomUUID()}`);
    const operationB = await createOperation(ownerB, workspaceB, `Records B ${randomUUID()}`);

    await db.insert(auditEventsTable).values([
      {
        workspaceId: workspaceA,
        eventType: "execution.succeeded",
        resourceType: "api_operation",
        resourceId: operationA.operationId,
        metadata: {
          actorId: ownerA,
          status: 204,
          destinationHost: "private-a.example.test",
          responseBytes: 123,
          secret: "must-never-be-returned",
        },
      },
      {
        workspaceId: workspaceA,
        eventType: "execution.denied",
        resourceType: "api_operation",
        resourceId: operationA.operationId,
        metadata: { actorId: ownerA, reason: "sensitive policy detail" },
      },
      {
        workspaceId: workspaceB,
        eventType: "execution.failed",
        resourceType: "api_operation",
        resourceId: operationB.operationId,
        metadata: { actorId: ownerB, code: "UPSTREAM_FAILURE" },
      },
    ]);

    await request(app)
      .get("/api/execution-logs")
      .set("x-test-user-id", "__unauthenticated__")
      .expect(401);

    const response = await request(app)
      .get("/api/execution-logs?page=1&pageSize=50")
      .set(auth(ownerA))
      .expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.every((item: { workspaceId: string }) =>
      item.workspaceId === workspaceA)).toBe(true);
    expect(response.body.items.map((item: { eventType: string }) => item.eventType))
      .toEqual(expect.arrayContaining(["execution.succeeded", "execution.denied"]));
    expect(response.body.items.find((item: { eventType: string }) =>
      item.eventType === "execution.succeeded")).toMatchObject({
        apiId: operationA.apiId,
        operationId: operationA.operationId,
        toolName: "listRecords",
        method: "GET",
        path: "/records",
        outcome: "SUCCESS",
        upstreamStatus: 204,
      });
    expect(JSON.stringify(response.body)).not.toMatch(
      /metadata|actorId|destinationHost|responseBytes|secret|private-a|sensitive policy detail/i,
    );

    const success = await request(app)
      .get("/api/execution-logs?outcome=SUCCESS&search=listRecords")
      .set(auth(ownerA))
      .expect(200);
    expect(success.body.total).toBe(1);
    expect(success.body.items[0].eventType).toBe("execution.succeeded");

    const paged = await request(app)
      .get("/api/execution-logs?page=2&pageSize=1")
      .set(auth(ownerA))
      .expect(200);
    expect(paged.body).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(paged.body.items).toHaveLength(1);

    await request(app)
      .get(`/api/execution-logs?workspaceId=${workspaceB}`)
      .set(auth(ownerA))
      .expect(404);
    await request(app)
      .get("/api/execution-logs?pageSize=51")
      .set(auth(ownerA))
      .expect(400);
  });
});
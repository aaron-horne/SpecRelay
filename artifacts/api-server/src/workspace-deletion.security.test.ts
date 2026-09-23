import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  apiSourcesTable,
  apiSpecVersionsTable,
  apiOperationsTable,
  auditEventsTable,
  connectorSecurityEventsTable,
  connectorActorsTable,
  connectorTokensTable,
  credentialMetadataTable,
  db,
  executionLeasesTable,
  operationPoliciesTable,
  workspaceMembershipsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import app from "./app";

function mcp(workspaceId: string, userId: string, method: string) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("x-test-user-id", userId)
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method)
    .send({ jsonrpc: "2.0", id: randomUUID(), method, params: {} });
}

describe.sequential("workspace deletion security", () => {
  it("requires an exact name confirmation and OWNER authorization", async () => {
    const owner = `delete-owner-${randomUUID()}`;
    const member = `delete-member-${randomUUID()}`;
    const outsider = `delete-outsider-${randomUUID()}`;
    const name = `Delete me ${randomUUID()}`;
    const created = await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name }).expect(201);
    const workspaceId = created.body.id as string;
    await db.insert(workspaceMembershipsTable).values({ workspaceId, userId: member, role: "MEMBER" });

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", member)
      .send({ name }).expect(403);
    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", outsider)
      .send({ name }).expect(404);
    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner)
      .send({ name: `${name}-wrong` }).expect(400);
  });

  it("tombstones the workspace, cleans active data, and retains truthful history", async () => {
    const owner = `delete-success-${randomUUID()}`;
    const untouchedName = `Untouched ${randomUUID()}`;
    const name = `Cleanup ${randomUUID()}`;
    const untouchedId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name: untouchedName }).expect(201)).body.id as string;
    const workspaceId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name }).expect(201)).body.id as string;
    const apiId = (await request(app).post(`/api/workspaces/${workspaceId}/apis`)
      .set("x-test-user-id", owner).send({ name: "To remove" }).expect(201)).body.id as string;
    const securityId = randomUUID();
    const securityActorId = randomUUID();
    await db.insert(connectorSecurityEventsTable).values({
      id: securityId,
      eventType: "test.event",
      workspaceId,
      actorId: securityActorId,
    });

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner)
      .send({ name }).expect(204);

    await request(app).get("/api/workspaces").set("x-test-user-id", owner).expect(200)
      .then((response) => expect(response.body.some((row: { id: string }) => row.id === workspaceId)).toBe(false));
    await request(app).get(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).expect(404);
    await request(app).get(`/api/workspaces/${workspaceId}/overview`).set("x-test-user-id", owner).expect(404);
    await request(app).get(`/api/workspaces/${workspaceId}/apis`).set("x-test-user-id", owner).expect(404);
    await mcp(workspaceId, owner, "tools/list").expect(404);
    await request(app).get(`/api/workspaces/${untouchedId}`).set("x-test-user-id", owner).expect(200);
    await request(app).get(`/api/workspaces/${untouchedId}/overview`).set("x-test-user-id", owner).expect(200);
    await expect(db.select().from(apiSourcesTable).where(eq(apiSourcesTable.id, apiId))).resolves.toHaveLength(0);
    const [tombstone] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    await expect(db.select().from(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.workspaceId, workspaceId))).resolves.toHaveLength(0);
    for (const table of [
      apiSpecVersionsTable, apiOperationsTable, operationPoliciesTable,
      credentialMetadataTable, connectorActorsTable, connectorTokensTable,
      executionLeasesTable,
    ]) {
      await expect(db.select().from(table).where(eq(table.workspaceId, workspaceId))).resolves.toHaveLength(0);
    }
    await expect(db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.eventType, "workspace.deleted"),
    ))).resolves.toHaveLength(1);
    const [security] = await db.select().from(connectorSecurityEventsTable)
      .where(eq(connectorSecurityEventsTable.id, securityId));
    expect(security?.workspaceId).toBe(workspaceId);
    expect(security?.actorId).toBe(securityActorId);
    await expect(db.insert(workspaceMembershipsTable).values({
      workspaceId, userId: `rejected-${randomUUID()}`, role: "MEMBER",
    })).rejects.toThrow();
    await expect(db.insert(apiSourcesTable).values({
      workspaceId, name: `rejected-${randomUUID()}`,
    })).rejects.toThrow();
  });

  it("rolls back when an execution lease is active", async () => {
    const owner = `delete-busy-${randomUUID()}`;
    const name = `Busy ${randomUUID()}`;
    const workspaceId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name }).expect(201)).body.id as string;
    const apiId = (await request(app).post(`/api/workspaces/${workspaceId}/apis`)
      .set("x-test-user-id", owner).send({ name: "Busy API" }).expect(201)).body.id as string;
    const imported = await request(app).post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
      .set("x-test-user-id", owner)
      .send({ document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Busy API", version: "1.0.0" },
        paths: { "/items": { get: { responses: { "200": { description: "ok" } } } } },
      }) }).expect(201);
    const operation = imported.body.operations[0] as { id: string; specificationId: string };
    await db.insert(executionLeasesTable).values({
      workspaceId,
      apiId,
      specificationId: operation.specificationId,
      operationId: operation.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner)
      .send({ name }).expect(409);
    const [busyWorkspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    expect(busyWorkspace?.deletedAt).toBeNull();
    await expect(db.select().from(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.workspaceId, workspaceId)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(apiSourcesTable).where(eq(apiSourcesTable.id, apiId)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.eventType, "workspace.deleted"),
    ))).resolves.toHaveLength(0);
  });
});
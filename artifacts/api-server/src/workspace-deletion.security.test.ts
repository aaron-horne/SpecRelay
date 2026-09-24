import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  semanticProviderConfigsTable,
  operationPoliciesTable,
  workspaceMembershipsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import app from "./app";

const sameOrigin = "http://127.0.0.1";

function mcp(workspaceId: string, userId: string, method: string) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("x-test-user-id", userId)
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method)
    .send({ jsonrpc: "2.0", id: randomUUID(), method, params: {} });
}

function connectorMcp(workspaceId: string, token: string, method: string) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/mcp`)
    .set("authorization", `Bearer ${token}`)
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method)
    .send({ jsonrpc: "2.0", id: randomUUID(), method, params: {} });
}

const previousConnectorFlag = process.env.CONNECTOR_TOKENS_ENABLED;
beforeAll(() => { process.env.CONNECTOR_TOKENS_ENABLED = "true"; });
afterAll(() => {
  if (previousConnectorFlag === undefined) delete process.env.CONNECTOR_TOKENS_ENABLED;
  else process.env.CONNECTOR_TOKENS_ENABLED = previousConnectorFlag;
});

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

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", member).set("origin", sameOrigin)
      .send({ name }).expect(403);
    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", outsider).set("origin", sameOrigin)
      .send({ name }).expect(404);
    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).set("origin", sameOrigin)
      .send({ name: `${name}-wrong` }).expect(400);
  });

  it("rejects missing, null, malformed, and cross-site origins before deletion", async () => {
    const owner = `delete-csrf-${randomUUID()}`;
    const name = `CSRF ${randomUUID()}`;
    const workspaceId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name }).expect(201)).body.id as string;
    const forged = () => request(app).delete(`/api/workspaces/${workspaceId}`)
      .set("x-test-user-id", owner).send({ name });

    await forged().expect(403);
    await forged().set("origin", "null").expect(403);
    await forged().set("origin", "https://attacker.example").expect(403);
    await forged().set("origin", "not-an-origin").expect(403);

    await request(app).get(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).expect(200);
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
    await db.insert(semanticProviderConfigsTable).values({
      workspaceId,
      provider: `provider-${randomUUID()}`,
      enabled: true,
      secretCiphertext: "encrypted",
      secretIv: "iv",
      secretAuthTag: "tag",
      keyId: "key",
      keyVersion: 1,
    });
    // Controlled integration fixture: production mutation requires separate approval.
    const issued = await request(app).post(`/api/workspaces/${workspaceId}/connectors`)
      .set("x-test-user-id", owner)
      .send({ name: "Historical connector", scopes: ["tools:list"] }).expect(201);
    const { token, actorId } = issued.body as { token: string; actorId: string };
    await connectorMcp(untouchedId, token, "tools/list").expect(404);
    const [securityBefore] = await db.select().from(connectorSecurityEventsTable)
      .where(and(
        eq(connectorSecurityEventsTable.workspaceId, workspaceId),
        eq(connectorSecurityEventsTable.actorId, actorId),
        eq(connectorSecurityEventsTable.eventType, "workspace_mismatch"),
      ));
    expect(securityBefore).toBeDefined();
    await expect(db.select().from(connectorActorsTable)
      .where(eq(connectorActorsTable.id, actorId))).resolves.toHaveLength(1);
    await expect(db.select().from(connectorTokensTable)
      .where(eq(connectorTokensTable.actorId, actorId))).resolves.toHaveLength(1);

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).set("origin", sameOrigin)
      .send({ name }).expect(204);

    await request(app).get("/api/workspaces").set("x-test-user-id", owner).expect(200)
      .then((response) => expect(response.body.some((row: { id: string }) => row.id === workspaceId)).toBe(false));
    await request(app).get(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).expect(404);
    await request(app).get(`/api/workspaces/${workspaceId}/overview`).set("x-test-user-id", owner).expect(404);
    await request(app).get(`/api/workspaces/${workspaceId}/apis`).set("x-test-user-id", owner).expect(404);
    await mcp(workspaceId, owner, "tools/list").expect(404);
    await connectorMcp(workspaceId, token, "tools/list").expect(401);
    await request(app).get(`/api/workspaces/${untouchedId}`).set("x-test-user-id", owner).expect(200);
    await request(app).get(`/api/workspaces/${untouchedId}/overview`).set("x-test-user-id", owner).expect(200);
    await expect(db.select().from(apiSourcesTable).where(eq(apiSourcesTable.id, apiId))).resolves.toHaveLength(0);
    const [tombstone] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    await expect(db.select().from(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.workspaceId, workspaceId))).resolves.toHaveLength(0);
    for (const table of [
      apiSpecVersionsTable, apiOperationsTable, operationPoliciesTable,
      credentialMetadataTable, connectorActorsTable, connectorTokensTable,
      executionLeasesTable, semanticProviderConfigsTable,
    ]) {
      await expect(db.select().from(table).where(eq(table.workspaceId, workspaceId))).resolves.toHaveLength(0);
    }
    await expect(db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, workspaceId),
      eq(auditEventsTable.eventType, "workspace.deleted"),
    ))).resolves.toHaveLength(1);
    const [security] = await db.select().from(connectorSecurityEventsTable)
      .where(eq(connectorSecurityEventsTable.id, securityBefore!.id));
    expect(security?.workspaceId).toBe(workspaceId);
    expect(security?.actorId).toBe(actorId);
    expect(security?.eventType).toBe("workspace_mismatch");
    expect(security?.occurredAt).toEqual(securityBefore?.occurredAt);
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

    await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).set("origin", sameOrigin)
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

  it("rolls back cleanup and the tombstone if the final audit insert fails", async () => {
    const owner = `delete-rollback-${randomUUID()}`;
    const name = `Rollback ${randomUUID()}`;
    const workspaceId = (await request(app).post("/api/workspaces").set("x-test-user-id", owner)
      .send({ name }).expect(201)).body.id as string;
    const apiId = (await request(app).post(`/api/workspaces/${workspaceId}/apis`)
      .set("x-test-user-id", owner).send({ name: "Still here" }).expect(201)).body.id as string;
    const suffix = randomUUID().replaceAll("-", "");
    const trigger = `test_delete_rollback_${suffix}`;
    const functionName = `test_delete_rollback_fn_${suffix}`;

    try {
      // Restrict the injected failure to this workspace's deletion event.
      await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$`));
      await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events
        FOR EACH ROW WHEN (NEW.event_type = 'workspace.deleted'
          AND NEW.workspace_id = '${workspaceId}'::uuid)
        EXECUTE FUNCTION ${functionName}()`));

      await request(app).delete(`/api/workspaces/${workspaceId}`).set("x-test-user-id", owner).set("origin", sameOrigin)
        .send({ name }).expect(500);
      const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
      expect(workspace?.deletedAt).toBeNull();
      await expect(db.select().from(apiSourcesTable).where(eq(apiSourcesTable.id, apiId)))
        .resolves.toHaveLength(1);
      await expect(db.select().from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))).resolves.toHaveLength(1);
      await expect(db.select().from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, workspaceId),
        eq(auditEventsTable.eventType, "workspace.deleted"),
      ))).resolves.toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
  });
});
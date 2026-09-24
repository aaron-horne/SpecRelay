import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  and,
  eq,
} from "drizzle-orm";
import {
  auditEventsTable,
  db,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import { SemanticProviderService } from "./services/semantic-providers";
import type { SemanticProviderTestOutcome } from "./services/semantic-provider-adapters";

process.env.SESSION_SECRET ??= "semantic-provider-security-test-key";

const sameOrigin = "http://127.0.0.1";
const secret = "semantic-provider-test-secret";

function auth(userId: string) {
  return { "x-test-user-id": userId };
}

async function createWorkspace(ownerId = `semantic-owner-${randomUUID()}`) {
  const name = `Semantic provider ${randomUUID()}`;
  const response = await request(app)
    .post("/api/workspaces")
    .set(auth(ownerId))
    .send({ name })
    .expect(201);
  return { ownerId, id: response.body.id as string, name };
}

function endpoint(workspaceId: string, suffix = "") {
  return `/api/workspaces/${workspaceId}/semantic-providers/jev${suffix}`;
}

function save(workspaceId: string, userId: string, value = secret) {
  return request(app)
    .put(endpoint(workspaceId))
    .set(auth(userId))
    .set("origin", sameOrigin)
    .send({ secret: value });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.sequential("semantic provider API security", () => {
  it("restricts metadata to owners, hides outsiders, and enforces same-origin mutations", async () => {
    const { id: workspaceId, ownerId } = await createWorkspace();
    const memberId = `semantic-member-${randomUUID()}`;
    const outsiderId = `semantic-outsider-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId,
      userId: memberId,
      role: "MEMBER",
    });

    const metadata = await request(app)
      .get(endpoint(workspaceId))
      .set(auth(ownerId))
      .expect(200);
    expect(metadata.body).toMatchObject({
      provider: "jev",
      configured: false,
      enabled: false,
      credentialRevision: 0,
    });
    await request(app).get(endpoint(workspaceId)).set(auth(memberId)).expect(403);
    await request(app).get(endpoint(workspaceId)).set(auth(outsiderId)).expect(404);
    await save(workspaceId, memberId).expect(403);
    await request(app)
      .put(endpoint(workspaceId))
      .set(auth(ownerId))
      .send({ secret })
      .expect(403);
    await request(app)
      .put(endpoint(workspaceId))
      .set(auth(ownerId))
      .set("origin", "https://attacker.example")
      .send({ secret })
      .expect(403);
  });

  it("rechecks OWNER access in service methods independently of HTTP middleware", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      const memberId = `semantic-direct-member-${randomUUID()}`;
      await db.insert(workspaceMembershipsTable).values({
        workspaceId,
        userId: memberId,
        role: "MEMBER",
      });
      const service = new SemanticProviderService();
      await service.saveKey(workspaceId, ownerId, secret);

      await expect(service.getMetadata(workspaceId, memberId))
        .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
      await expect(service.saveKey(workspaceId, memberId, secret))
        .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
      await expect(service.deleteKey(workspaceId, memberId))
        .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
      await expect(service.setReady(workspaceId, memberId, false))
        .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
      await expect(service.test(workspaceId, memberId))
        .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("keeps configuration available while test/readiness are disabled by default", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    delete process.env.SEMANTIC_PROVIDERS_ENABLED;
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      const configured = await save(workspaceId, ownerId).expect(200);
      expect(configured.body).toMatchObject({
        configured: true,
        enabled: false,
        credentialRevision: 1,
      });
      expect(JSON.stringify(configured.body)).not.toContain(secret);
      expect(JSON.stringify(configured.body)).not.toMatch(/ciphertext|authTag|keyVersion|keyId/i);

      await request(app)
        .post(endpoint(workspaceId, "/test"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .expect(503);
      await request(app)
        .patch(endpoint(workspaceId, "/ready"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .send({ enabled: true })
        .expect(503);

      const row = (await db.select().from(semanticProviderConfigsTable)
        .where(eq(semanticProviderConfigsTable.workspaceId, workspaceId))).at(0);
      expect(row?.secretCiphertext).toBeTruthy();
      expect(JSON.stringify(row)).not.toContain(secret);
      const events = await db.select().from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, workspaceId),
        eq(auditEventsTable.resourceType, "semantic_provider"),
      ));
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(row?.secretCiphertext);
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("enforces secret size limits and invalidates test/readiness after replacement", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      await save(workspaceId, ownerId).expect(200);
      await request(app)
        .put(endpoint(workspaceId))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .send({ secret: "x".repeat(8193) })
        .expect(400);
      const [initial] = await db.select().from(semanticProviderConfigsTable)
        .where(eq(semanticProviderConfigsTable.workspaceId, workspaceId));
      await db.update(semanticProviderConfigsTable).set({
        enabled: true,
        lastTestOutcome: "success",
        testedRevision: initial!.credentialRevision,
      }).where(eq(semanticProviderConfigsTable.id, initial!.id));

      const replaced = await save(workspaceId, ownerId, `${secret}-replaced`).expect(200);
      expect(replaced.body.enabled).toBe(false);
      expect(replaced.body.lastTestOutcome).toBeNull();
      expect(replaced.body.testedRevision).toBeNull();
      expect(replaced.body.credentialRevision).toBe(initial!.credentialRevision + 1);
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("uses only the fixed Jev destination and bounds the upstream response", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      await save(workspaceId, ownerId).expect(200);
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response("ok", { status: 200 });
      });
      await request(app)
        .post(endpoint(workspaceId, "/test"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .send({ host: "attacker.example", model: "arbitrary", payload: "sensitive" })
        .expect(400);
      expect(capturedUrl).toBe("");
      const result = await request(app)
        .post(endpoint(workspaceId, "/test"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .expect(200);

      expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
      expect(capturedInit?.method).toBe("POST");
      expect(capturedInit?.redirect).toBe("manual");
      expect(capturedInit?.headers).toMatchObject({
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json",
      });
      expect(capturedInit?.body).toBe(JSON.stringify({ input: "Noul" }));
      expect(result.body).toMatchObject({ provider: "jev", outcome: "success", testedRevision: 1 });
      expect(JSON.stringify(result.body)).not.toMatch(/attacker|arbitrary|sensitive|secret/i);
      await request(app)
        .post(endpoint(workspaceId, "/test"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .expect(409);

      const oversizedWorkspace = await createWorkspace(ownerId);
      await save(oversizedWorkspace.id, ownerId).expect(200);
      vi.stubGlobal("fetch", async () => new Response("x".repeat(2_049), { status: 200 }));
      const oversized = await request(app)
        .post(endpoint(oversizedWorkspace.id, "/test"))
        .set(auth(ownerId))
        .set("origin", sameOrigin)
        .expect(200);
      expect(oversized.body.outcome).toBe("inconclusive");
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("discards a test result when the key revision changes in flight", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    let begin!: () => void;
    let complete!: (outcome: SemanticProviderTestOutcome) => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    const waiting = new Promise<SemanticProviderTestOutcome>((resolve) => { complete = resolve; });
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      const service = new SemanticProviderService({
        async test(): Promise<SemanticProviderTestOutcome> {
          begin();
          return waiting;
        },
      });
      await service.saveKey(workspaceId, ownerId, secret);
      const testing = service.test(workspaceId, ownerId);
      await began;
      await service.saveKey(workspaceId, ownerId, `${secret}-new`);
      complete("success");
      await expect(testing).rejects.toMatchObject({
        status: 409,
        code: "SEMANTIC_PROVIDER_REVISION_CONFLICT",
      });
      const [row] = await db.select().from(semanticProviderConfigsTable)
        .where(eq(semanticProviderConfigsTable.workspaceId, workspaceId));
      expect(row).toMatchObject({
        enabled: false,
        credentialRevision: 2,
        lastTestOutcome: null,
        testedRevision: null,
      });
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("retains the test cooldown across key replacement and delete/recreate", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      const service = new SemanticProviderService({
        async test(): Promise<SemanticProviderTestOutcome> {
          return "success";
        },
      });
      await service.saveKey(workspaceId, ownerId, secret);
      await service.test(workspaceId, ownerId);

      await service.saveKey(workspaceId, ownerId, `${secret}-replaced`);
      await expect(service.test(workspaceId, ownerId))
        .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROVIDER_TEST_RATE_LIMITED" });

      await service.deleteKey(workspaceId, ownerId);
      await service.saveKey(workspaceId, ownerId, `${secret}-recreated`);
      await expect(service.test(workspaceId, ownerId))
        .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROVIDER_TEST_RATE_LIMITED" });

      const reservations = await db.select()
        .from(auditEventsTable)
        .where(and(
          eq(auditEventsTable.workspaceId, workspaceId),
          eq(auditEventsTable.eventType, "semantic_provider.test.reserved"),
        ));
      expect(reservations).toHaveLength(1);
      expect(JSON.stringify(reservations)).not.toContain(secret);
      expect(JSON.stringify(reservations)).not.toMatch(/ciphertext|authTag|payload|host|model/i);
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("rejects a provider response if OWNER membership is revoked in flight", async () => {
    const previousFlag = process.env.SEMANTIC_PROVIDERS_ENABLED;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    let begin!: () => void;
    let complete!: (outcome: SemanticProviderTestOutcome) => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    const waiting = new Promise<SemanticProviderTestOutcome>((resolve) => { complete = resolve; });
    try {
      const { id: workspaceId, ownerId } = await createWorkspace();
      const service = new SemanticProviderService({
        async test(): Promise<SemanticProviderTestOutcome> {
          begin();
          return waiting;
        },
      });
      await service.saveKey(workspaceId, ownerId, secret);
      const testing = service.test(workspaceId, ownerId);
      await began;
      await db.delete(workspaceMembershipsTable).where(and(
        eq(workspaceMembershipsTable.workspaceId, workspaceId),
        eq(workspaceMembershipsTable.userId, ownerId),
      ));
      complete("success");
      await expect(testing).rejects.toMatchObject({
        status: 404,
        code: "WORKSPACE_NOT_FOUND",
      });

      const testResults = await db.select({ id: auditEventsTable.id })
        .from(auditEventsTable)
        .where(and(
          eq(auditEventsTable.workspaceId, workspaceId),
          eq(auditEventsTable.eventType, "semantic_provider.tested"),
        ));
      expect(testResults).toHaveLength(0);
    } finally {
      if (previousFlag === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      else process.env.SEMANTIC_PROVIDERS_ENABLED = previousFlag;
    }
  });

  it("requires a live workspace even when its old ID is retained", async () => {
    const { id: workspaceId, ownerId, name } = await createWorkspace();
    await request(app)
      .delete(`/api/workspaces/${workspaceId}`)
      .set(auth(ownerId))
      .set("origin", sameOrigin)
      .send({ name })
      .expect(204);
    await request(app).get(endpoint(workspaceId)).set(auth(ownerId)).expect(404);
  });
});
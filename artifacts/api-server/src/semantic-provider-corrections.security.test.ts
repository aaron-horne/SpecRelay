import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditEventsTable,
  db,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import { SemanticProviderService } from "./services/semantic-providers";
import type { SemanticProviderAdapter } from "./services/semantic-provider-adapters";

const origin = "http://127.0.0.1";
const secret = "phase-1a-refresh-test-secret";
const keySettings = [
  "CREDENTIAL_ENCRYPTION_KEY", "CREDENTIAL_ENCRYPTION_KEY_ID", "CREDENTIAL_ENCRYPTION_KEY_VERSION",
  "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS", "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID",
  "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION",
  "SEMANTIC_PROVIDERS_ENABLED", "SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS",
] as const;

async function workspace() {
  const ownerId = `phase1a-owner-${randomUUID()}`;
  const name = `Phase 1A ${randomUUID()}`;
  const created = await request(app).post("/api/workspaces")
    .set("x-test-user-id", ownerId).send({ name }).expect(201);
  return { id: created.body.id as string, ownerId, name };
}

function url(id: string, suffix = "") {
  return `/api/workspaces/${id}/semantic-providers/jev${suffix}`;
}

function asOwner(ownerId: string) {
  return { "x-test-user-id": ownerId, origin };
}

describe.sequential("Phase 1A provider corrections", () => {
  const savedSettings = new Map(keySettings.map((key) => [key, process.env[key]]));
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of savedSettings) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("refreshes previous-key encryption for an excluded OWNER without egress or changing test/readiness", async () => {
    const oldKey = randomBytes(32).toString("base64");
    const newKey = randomBytes(32).toString("base64");
    const { id, ownerId } = await workspace();
    delete process.env.SEMANTIC_PROVIDERS_ENABLED;
    delete process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
    process.env.CREDENTIAL_ENCRYPTION_KEY = oldKey;
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "phase1a-old";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "30";
    await request(app).put(url(id)).set(asOwner(ownerId)).send({ secret }).expect(200);
    const [before] = await db.select().from(semanticProviderConfigsTable)
      .where(eq(semanticProviderConfigsTable.workspaceId, id));

    process.env.CREDENTIAL_ENCRYPTION_KEY = newKey;
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "phase1a-new";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "31";
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = oldKey;
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID = "phase1a-old";
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "30";
    const outbound = vi.fn(() => { throw new Error("refresh must not contact Jev"); });
    vi.stubGlobal("fetch", outbound);

    await request(app).post(url(id, "/refresh-encryption"))
      .set({ "x-test-user-id": `member-${randomUUID()}`, origin }).expect(404);
    await request(app).post(url(id, "/refresh-encryption"))
      .set("x-test-user-id", ownerId).expect(403);
    await request(app).post(url(id, "/refresh-encryption"))
      .set(asOwner(ownerId)).send({ secret }).expect(400);
    const refreshed = await request(app).post(url(id, "/refresh-encryption"))
      .set(asOwner(ownerId)).expect(200);
    expect(refreshed.body).toMatchObject({
      configured: true, credentialUsable: true, enabled: false,
      rolloutEnabled: false, credentialRevision: 1, lastTestOutcome: null, testedRevision: null,
    });
    const [after] = await db.select().from(semanticProviderConfigsTable)
      .where(eq(semanticProviderConfigsTable.workspaceId, id));
    expect(after).toMatchObject({
      id: before!.id, keyId: "phase1a-new", keyVersion: 31,
      credentialRevision: 1, enabled: false, lastTestOutcome: null, testedRevision: null,
    });
    expect(after!.secretCiphertext).not.toEqual(before!.secretCiphertext);
    expect(outbound).not.toHaveBeenCalled();

    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_ID;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;
    const metadata = await request(app).get(url(id)).set("x-test-user-id", ownerId).expect(200);
    expect(metadata.body.credentialUsable).toBe(true);
    expect(JSON.stringify(metadata.body)).not.toContain(secret);
    expect(JSON.stringify(metadata.body)).not.toMatch(/ciphertext|authTag|keyVersion|keyId/i);
    const events = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, id), eq(auditEventsTable.eventType, "semantic_provider.key_reencrypted"),
    ));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(after!.secretCiphertext);
  });

  it("reports an inaccessible old-key record as unusable, never Ready, and recovers by replacement", async () => {
    const { id, ownerId } = await workspace();
    const oldKey = randomBytes(32).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_KEY = oldKey;
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "lost-old";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "40";
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
    await request(app).put(url(id)).set(asOwner(ownerId)).send({ secret }).expect(200);
    await db.update(semanticProviderConfigsTable).set({
      enabled: true, testedRevision: 1, lastTestOutcome: "success",
    }).where(eq(semanticProviderConfigsTable.workspaceId, id));
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "lost-new";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "41";
    const stale = await request(app).get(url(id)).set("x-test-user-id", ownerId).expect(200);
    expect(stale.body).toMatchObject({
      configured: true, credentialUsable: false, enabled: false,
      lastTestOutcome: "success", testedRevision: 1,
    });
    await request(app).patch(url(id, "/ready")).set(asOwner(ownerId))
      .send({ enabled: true }).expect(503);
    const unavailable = await request(app).post(url(id, "/refresh-encryption"))
      .set(asOwner(ownerId)).expect(503);
    expect(unavailable.body.code).toBe("SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
    expect(JSON.stringify(unavailable.body)).not.toContain(secret);
    const replaced = await request(app).put(url(id)).set(asOwner(ownerId))
      .send({ secret: `${secret}-replacement` }).expect(200);
    expect(replaced.body).toMatchObject({
      credentialUsable: true, enabled: false, credentialRevision: 2,
      lastTestOutcome: null, testedRevision: null,
    });
  });

  it("never dispatches when live OWNER, workspace, key, or rollout changes after reservation", async () => {
    for (const change of ["member", "workspace", "replace", "delete", "rollout"] as const) {
      const { id, ownerId, name } = await workspace();
      process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
      process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
      let release!: () => void;
      let reserved!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { reserved = resolve; });
      const adapter: SemanticProviderAdapter = { dispatch: vi.fn(async () => ({
        outcome: Promise.resolve("success" as const),
      })) };
      const service = new SemanticProviderService(adapter, async () => { reserved(); await paused; });
      await service.saveKey(id, ownerId, secret);
      const testing = service.test(id, ownerId);
      await reached;
      if (change === "member") {
        await db.update(workspaceMembershipsTable).set({ role: "MEMBER" })
          .where(and(eq(workspaceMembershipsTable.workspaceId, id), eq(workspaceMembershipsTable.userId, ownerId)));
      } else if (change === "workspace") {
        await request(app).delete(`/api/workspaces/${id}`)
          .set(asOwner(ownerId)).send({ name }).expect(204);
      } else if (change === "replace") {
        await service.saveKey(id, ownerId, `${secret}-new`);
      } else if (change === "delete") {
        await service.deleteKey(id, ownerId);
      } else {
        delete process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
      }
      release();
      await expect(testing).rejects.toMatchObject({
        status: change === "rollout" ? 503 :
          change === "replace" || change === "delete" ? 409 :
          change === "member" ? 403 : 404,
      });
      expect(adapter.dispatch).not.toHaveBeenCalled();
      const results = await db.select().from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, id), eq(auditEventsTable.eventType, "semantic_provider.tested"),
      ));
      expect(results).toHaveLength(0);
    }
  });

  it("rechecks operator rollout after the awaited dispatch prerequisites, before egress", async () => {
    for (const change of ["global", "allowlist"] as const) {
      const { id, ownerId } = await workspace();
      process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
      process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
      let reached!: () => void;
      let release!: () => void;
      const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const adapter: SemanticProviderAdapter = { dispatch: vi.fn(async () => ({
        outcome: Promise.resolve("success" as const),
      })) };
      const service = new SemanticProviderService(adapter, undefined, async () => {
        reached();
        await paused;
      });
      await service.saveKey(id, ownerId, secret);
      const testing = service.test(id, ownerId);
      await atBoundary;
      if (change === "global") {
        delete process.env.SEMANTIC_PROVIDERS_ENABLED;
      } else {
        process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = randomUUID();
      }
      release();
      await expect(testing).rejects.toMatchObject({
        status: 503,
        code: change === "global" ? "SEMANTIC_PROVIDERS_DISABLED" :
          "SEMANTIC_PROVIDER_WORKSPACE_NOT_ALLOWED",
      });
      expect(adapter.dispatch).not.toHaveBeenCalled();
      const metadata = await service.getMetadata(id, ownerId);
      expect(metadata.testCooldownUntil?.getTime()).toBeGreaterThan(Date.now());
      const results = await db.select().from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, id), eq(auditEventsTable.eventType, "semantic_provider.tested"),
      ));
      expect(results).toHaveLength(0);
    }
  });

  it("serializes credential replacement with dispatch until the request is on the wire", async () => {
    const { id, ownerId } = await workspace();
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
    let entered!: () => void;
    let allowHeaders!: () => void;
    let finish!: () => void;
    const enteredDispatch = new Promise<void>((resolve) => { entered = resolve; });
    const responseHeaders = new Promise<void>((resolve) => { allowHeaders = resolve; });
    const result = new Promise<"success">((resolve) => { finish = () => resolve("success"); });
    const service = new SemanticProviderService({
      async dispatch() {
        entered();
        await responseHeaders;
        return { outcome: result };
      },
    });
    await service.saveKey(id, ownerId, secret);
    const testing = service.test(id, ownerId);
    await enteredDispatch;
    let replacementFinished = false;
    const replacement = service.saveKey(id, ownerId, `${secret}-next`)
      .then(() => { replacementFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(replacementFinished).toBe(false);
    allowHeaders();
    await replacement;
    finish();
    await expect(testing).rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROVIDER_REVISION_CONFLICT" });
  });

  it("exposes the audit-backed cooldown after replacement and recreation despite null lastTestedAt", async () => {
    const { id, ownerId } = await workspace();
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
    const service = new SemanticProviderService({
      async dispatch() { return { outcome: Promise.resolve("success" as const) }; },
    });
    await service.saveKey(id, ownerId, secret);
    await service.test(id, ownerId);
    const replaced = await service.saveKey(id, ownerId, `${secret}-new`);
    expect(replaced.lastTestedAt).toBeNull();
    expect(replaced.testCooldownUntil?.getTime()).toBeGreaterThan(Date.now());
    await service.deleteKey(id, ownerId);
    const recreated = await service.saveKey(id, ownerId, `${secret}-recreated`);
    expect(recreated.lastTestedAt).toBeNull();
    expect(recreated.testCooldownUntil?.getTime()).toBeGreaterThan(Date.now());
    const metadata = await request(app).get(url(id)).set("x-test-user-id", ownerId).expect(200);
    expect(new Date(metadata.body.testCooldownUntil as string).getTime()).toBeGreaterThan(Date.now());
    const response = await request(app).post(url(id, "/test"))
      .set(asOwner(ownerId)).expect(409);
    expect(response.body.code).toBe("SEMANTIC_PROVIDER_TEST_RATE_LIMITED");
  });

  it("restores only a future-phase preference after re-allowlisting, without automatic egress", async () => {
    const { id, ownerId } = await workspace();
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
    const outbound = vi.fn(async () => new Response(JSON.stringify({
      model: "jev-latest", answers: { marker_present: { type: "noul", noul: 0.5 } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", outbound);
    await request(app).put(url(id)).set(asOwner(ownerId)).send({ secret }).expect(200);
    await request(app).post(url(id, "/test")).set(asOwner(ownerId)).expect(200);
    await request(app).patch(url(id, "/ready")).set(asOwner(ownerId))
      .send({ enabled: true }).expect(200);
    expect(outbound).toHaveBeenCalledTimes(1);
    delete process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
    const paused = await request(app).get(url(id)).set("x-test-user-id", ownerId).expect(200);
    expect(paused.body.enabled).toBe(false);
    process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = id;
    const restored = await request(app).get(url(id)).set("x-test-user-id", ownerId).expect(200);
    expect(restored.body).toMatchObject({ enabled: true, credentialUsable: true, testedRevision: 1 });
    expect(outbound).toHaveBeenCalledTimes(1);
  });
});
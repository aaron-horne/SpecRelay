import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  operationPoliciesTable,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import { SemanticAnalysisService } from "./services/semantic-analysis";
import { SemanticProviderService } from "./services/semantic-providers";
import type { JevCandidate, JevOperationInput } from "./services/semantic-analysis-adapter";
import type { SemanticProviderAdapter } from "./services/semantic-provider-adapters";
import { securityServices } from "./services/security";

process.env.SESSION_SECRET ??= "semantic-mcp-publication-test-key";

const sameOrigin = "http://127.0.0.1";
const secret = "publication-test-provider-secret";
const priorRollout = process.env.SEMANTIC_PROVIDERS_ENABLED;
const priorAllowlist = process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
const originalBroker = securityServices.outboundRequestBroker;
const auth = (userId: string) => ({ "x-test-user-id": userId });

function restoreEnvironment() {
  if (priorRollout === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
  else process.env.SEMANTIC_PROVIDERS_ENABLED = priorRollout;
  if (priorAllowlist === undefined) delete process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
  else process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = priorAllowlist;
}

async function fixture() {
  const ownerId = `publication-owner-${randomUUID()}`;
  const workspace = await request(app).post("/api/workspaces").set(auth(ownerId))
    .send({ name: `Publication ${randomUUID()}` }).expect(201);
  const workspaceId = workspace.body.id as string;
  const api = await request(app).post(`/api/workspaces/${workspaceId}/apis`).set(auth(ownerId))
    .send({ name: "Publication fixture" }).expect(201);
  const apiId = api.body.id as string;
  const imported = await request(app).post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
    .set(auth(ownerId)).send({
      document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Publication API", version: "1" },
        servers: [{ url: "https://publication.example.test/v1" }],
        paths: {
          "/records/{recordId}": {
            get: {
              operationId: "getRecord",
              summary: "Read a record",
              description: "Imported operation description",
              parameters: [{ name: "recordId", in: "path", required: true, schema: { type: "string" } }],
              responses: { "200": { description: "A record was found" } },
            },
          },
        },
      }),
    }).expect(201);
  const operationId = imported.body.operations[0].id as string;
  await request(app).patch(`/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operationId}`)
    .set(auth(ownerId)).send({ enabled: true }).expect(200);

  process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
  process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = workspaceId;
  const providerDispatch = vi.fn(async () => ({ outcome: Promise.resolve("success" as const) }));
  const providerAdapter: SemanticProviderAdapter = { dispatch: providerDispatch };
  const provider = new SemanticProviderService(providerAdapter);
  await provider.saveKey(workspaceId, ownerId, secret);
  await provider.test(workspaceId, ownerId);
  await provider.setReady(workspaceId, ownerId, true);
  return { workspaceId, apiId, operationId, ownerId, provider, providerDispatch };
}

function mcp(workspaceId: string, method: string, params?: object, actorId?: string) {
  const toolName = method === "tools/call" && params && "name" in params
    ? String(params.name)
    : undefined;
  const builder = request(app).post(`/api/workspaces/${workspaceId}/mcp`)
    .set("x-test-user-id", actorId ?? "publication-mcp-client")
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", method);
  if (toolName) builder.set("mcp-name", toolName);
  return builder.send({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "publication-security-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
}

async function createProposal(
  data: Awaited<ReturnType<typeof fixture>>,
  decision: "accepted" | "rejected" = "accepted",
) {
  const dispatch = vi.fn(async (_secret: string, _operation: JevOperationInput, candidates: JevCandidate[]) => ({
    judgment: Promise.resolve({
      abstained: false,
      candidateId: candidates.find((candidate) => candidate.sourceField === "summary")!.id,
      confidence: 0.93,
    }),
  }));
  const service = new SemanticAnalysisService({ dispatch });
  const preflight = await service.prepare(data.workspaceId, data.apiId, data.operationId, data.ownerId);
  const authorized = await service.confirm(
    data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightHandle, true,
  );
  const analyzed = await service.analyze(
    data.workspaceId, data.apiId, data.operationId, data.ownerId, authorized.dispatchToken,
  );
  if (!analyzed.proposal) throw new Error("Expected the deterministic adapter to create a proposal");
  const proposalId = analyzed.proposal.id;
  await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/semantic-proposals/${proposalId}`)
    .set(auth(data.ownerId)).set("origin", sameOrigin).send({ decision }).expect(200);
  return { proposalId, dispatch };
}

function publicationPath(workspaceId: string, apiId: string, proposalId: string) {
  return `/api/workspaces/${workspaceId}/apis/${apiId}/semantic-proposals/${proposalId}/mcp-publication`;
}

function publicationPreviewPath(path: string) {
  return `${path}/preview`;
}

function previewPublication(path: string, actorId: string, origin = sameOrigin) {
  const builder = request(app).post(publicationPreviewPath(path)).set(auth(actorId));
  if (origin) builder.set("origin", origin);
  return builder.send({});
}

function descriptors(response: { body: { result: { tools: Array<Record<string, unknown>> } } }) {
  return response.body.result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

afterEach(() => {
  restoreEnvironment();
  securityServices.outboundRequestBroker = originalBroker;
});

describe.sequential("Phase 3 MCP description publication security", () => {
  it("blocks preview and direct publication when tools/list cannot list the operation without changing governance", async () => {
    const data = await fixture();
    const { proposalId, dispatch } = await createProposal(data);
    const path = publicationPath(data.workspaceId, data.apiId, proposalId);
    const eligiblePreview = await previewPublication(path, data.ownerId).expect(200);

    await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}`)
      .set(auth(data.ownerId)).send({ enabled: false }).expect(200);
    const [disabledOperation] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const [disabledPolicy] = await db.select().from(operationPoliciesTable)
      .where(eq(operationPoliciesTable.operationId, data.operationId));
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))).toEqual([]);

    const deniedPreview = await previewPublication(path, data.ownerId).expect(409);
    expect(deniedPreview.body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    const deniedPublish = await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: eligiblePreview.body.previewToken }).expect(409);
    expect(deniedPublish.body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    expect(await db.select().from(apiOperationsTable).where(eq(apiOperationsTable.id, data.operationId)))
      .toEqual([disabledOperation]);
    expect(await db.select().from(operationPoliciesTable).where(eq(operationPoliciesTable.operationId, data.operationId)))
      .toEqual([disabledPolicy]);
    const [accepted] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(accepted).toMatchObject({ status: "accepted", mcpPublishedAt: null });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(data.providerDispatch).toHaveBeenCalledTimes(1);

    await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}`)
      .set(auth(data.ownerId)).send({ enabled: true }).expect(200);
    const [eligibleOperation] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const [eligiblePolicy] = await db.select().from(operationPoliciesTable)
      .where(eq(operationPoliciesTable.operationId, data.operationId));
    const preview = await previewPublication(path, data.ownerId).expect(200);
    await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: preview.body.previewToken }).expect(200);
    expect(await db.select().from(apiOperationsTable).where(eq(apiOperationsTable.id, data.operationId)))
      .toEqual([eligibleOperation]);
    expect(await db.select().from(operationPoliciesTable).where(eq(operationPoliciesTable.operationId, data.operationId)))
      .toEqual([eligiblePolicy]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(data.providerDispatch).toHaveBeenCalledTimes(1);
  });

  it("requires ALLOW and execution approval independently, plus the remaining listing rules", async () => {
    const data = await fixture();
    const { proposalId, dispatch } = await createProposal(data);
    const path = publicationPath(data.workspaceId, data.apiId, proposalId);
    const baselinePreview = await previewPublication(path, data.ownerId).expect(200);
    const policyWhere = eq(operationPoliciesTable.operationId, data.operationId);
    const operationWhere = eq(apiOperationsTable.id, data.operationId);

    await db.update(operationPoliciesTable).set({ decision: "DENY" }).where(policyWhere);
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))).toEqual([]);
    expect((await previewPublication(path, data.ownerId).expect(409)).body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    expect((await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: baselinePreview.body.previewToken }).expect(409)).body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    await db.update(operationPoliciesTable).set({ decision: "ALLOW", executionApproved: false }).where(policyWhere);
    expect((await previewPublication(path, data.ownerId).expect(409)).body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    await db.update(operationPoliciesTable).set({ executionApproved: true }).where(policyWhere);
    await db.update(apiOperationsTable).set({ method: "POST" }).where(operationWhere);
    expect((await previewPublication(path, data.ownerId).expect(409)).body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    await db.update(apiOperationsTable).set({ method: "GET" }).where(operationWhere);
    await db.update(apiSpecVersionsTable).set({ serverUrls: ["http://publication.example.test/v1"] })
      .where(eq(apiSpecVersionsTable.apiId, data.apiId));
    expect((await previewPublication(path, data.ownerId).expect(409)).body.code).toBe("SEMANTIC_MCP_OPERATION_NOT_LISTABLE");
    const [proposal] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(proposal).toMatchObject({ status: "accepted", mcpPublishedAt: null });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(data.providerDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps acceptance and preview private, then publishes only after OWNER confirmation", async () => {
    const data = await fixture();
    const { proposalId, dispatch } = await createProposal(data);
    const before = await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200);
    const originalDescriptor = descriptors(before)[0]!;
    expect(originalDescriptor.description).toBe("Imported operation description (unauthenticated)");
    const [operationBefore] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const [specificationBefore] = await db.select().from(apiSpecVersionsTable)
      .where(eq(apiSpecVersionsTable.apiId, data.apiId));
    const [proposalBefore] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(proposalBefore?.mcpPublishedAt).toBeNull();

    const memberId = `publication-member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId: data.workspaceId, userId: memberId, role: "MEMBER",
    });
    const path = publicationPath(data.workspaceId, data.apiId, proposalId);
    await previewPublication(path, memberId).expect(403);
    await request(app).post(path).set(auth(memberId)).set("origin", sameOrigin)
      .send({ previewToken: "untrusted" }).expect(403);
    const outsider = `publication-outsider-${randomUUID()}`;
    const foreignPath = publicationPath(randomUUID(), data.apiId, proposalId);
    await previewPublication(foreignPath, outsider).expect(404);
    await request(app).post(path).set(auth(data.ownerId)).send({})
      .expect(403);

    const previewResponse = await previewPublication(path, data.ownerId).expect(200);
    expect(previewResponse.body).toMatchObject({
      importedDescription: "Imported operation description",
      proposalText: "Read a record",
      toolDescription: "Read a record (unauthenticated)",
      previewToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    });
    expect(previewResponse.body.previewToken).not.toBe("Read a record");
    const [proposalAfterPreview] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(proposalAfterPreview?.mcpPublishedAt).toBeNull();
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))).toEqual([originalDescriptor]);

    const wrongToken = await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: randomUUID() }).expect(409);
    expect(wrongToken.body.code).toBe("SEMANTIC_MCP_PREVIEW_STALE");
    const alternateOwnerId = `publication-alternate-owner-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({
      workspaceId: data.workspaceId, userId: alternateOwnerId, role: "OWNER",
    });
    const otherActorGrant = await request(app).post(path).set(auth(alternateOwnerId)).set("origin", sameOrigin)
      .send({ previewToken: previewResponse.body.previewToken }).expect(409);
    expect(otherActorGrant.body.code).toBe("SEMANTIC_MCP_PREVIEW_STALE");
    const [afterWrongToken] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(afterWrongToken?.mcpPublishedAt).toBeNull();

    const published = await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: previewResponse.body.previewToken }).expect(200);
    expect(published.body).toMatchObject({ id: proposalId, status: "accepted", mcpPublishedAt: expect.any(String) });
    const liveDescriptor = descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))[0]!;
    expect(liveDescriptor).toEqual({
      ...originalDescriptor,
      description: "Read a record (unauthenticated)",
    });
    expect(liveDescriptor.name).toBe(originalDescriptor.name);
    expect(liveDescriptor.inputSchema).toEqual(originalDescriptor.inputSchema);

    const [operationAfter] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const [specificationAfter] = await db.select().from(apiSpecVersionsTable)
      .where(eq(apiSpecVersionsTable.apiId, data.apiId));
    expect(operationAfter).toEqual(operationBefore);
    expect(specificationAfter).toEqual(specificationBefore);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const brokerExecute = vi.fn(async (candidate: { destination: URL }) => {
      expect(candidate.destination.href).toBe("https://publication.example.test/v1/records/42");
      return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"id":"42"}') };
    });
    securityServices.outboundRequestBroker = {
      async validate() { throw new Error("validate is performed by execute"); },
      execute: brokerExecute,
    };
    const execution = await mcp(data.workspaceId, "tools/call", {
      name: liveDescriptor.name,
      arguments: { recordId: "42" },
    }, data.ownerId).expect(200);
    expect(execution.body.result.isError).toBe(false);
    expect(brokerExecute).toHaveBeenCalledTimes(1);

    const publicationAudits = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_mcp_overlay.published"),
    ));
    expect(publicationAudits).toHaveLength(1);
    expect(publicationAudits[0]?.metadata).toEqual({
      actorId: data.ownerId,
      apiId: data.apiId,
      specificationId: proposalBefore?.specificationId,
      operationId: data.operationId,
      credentialRevision: proposalBefore?.credentialRevision,
    });
    const serializedAudit = JSON.stringify(publicationAudits);
    expect(serializedAudit).not.toContain(secret);
    expect(serializedAudit).not.toContain(previewResponse.body.previewToken);
    expect(serializedAudit).not.toContain("Read a record");
  });

  it("revokes to the imported descriptor and immediately hides nonaccepted or stale proposals", async () => {
    const data = await fixture();
    const { proposalId } = await createProposal(data);
    const path = publicationPath(data.workspaceId, data.apiId, proposalId);
    const preview = await previewPublication(path, data.ownerId).expect(200);
    await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: preview.body.previewToken }).expect(200);
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))[0]?.description)
      .toBe("Read a record (unauthenticated)");

    await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}`)
      .set(auth(data.ownerId)).send({ enabled: false }).expect(200);
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))).toEqual([]);
    const [disabledOperation] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const [disabledPolicy] = await db.select().from(operationPoliciesTable)
      .where(eq(operationPoliciesTable.operationId, data.operationId));
    await request(app).delete(path).set(auth(data.ownerId)).set("origin", sameOrigin).expect(200);
    expect(await db.select().from(apiOperationsTable).where(eq(apiOperationsTable.id, data.operationId)))
      .toEqual([disabledOperation]);
    expect(await db.select().from(operationPoliciesTable).where(eq(operationPoliciesTable.operationId, data.operationId)))
      .toEqual([disabledPolicy]);
    const [afterRevoke] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(afterRevoke).toMatchObject({ status: "accepted", mcpPublishedAt: null });
    expect(data.providerDispatch).toHaveBeenCalledTimes(1);

    await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}`)
      .set(auth(data.ownerId)).send({ enabled: true }).expect(200);
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");
    const reusedGrant = await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: preview.body.previewToken }).expect(409);
    expect(reusedGrant.body.code).toBe("SEMANTIC_MCP_PREVIEW_STALE");
    const [revoked] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(revoked?.mcpPublishedAt).toBeNull();

    const rejected = await fixture();
    const rejectedProposal = await createProposal(rejected, "rejected");
    const pending = await previewPublication(
      publicationPath(rejected.workspaceId, rejected.apiId, rejectedProposal.proposalId), rejected.ownerId,
    ).expect(409);
    expect(pending.body.code).toBe("SEMANTIC_MCP_PROPOSAL_NOT_ACCEPTED");
  });

  it("rejects stale-source, old-version, rejected, and wrong-credential-revision proposals", async () => {
    const data = await fixture();
    const { proposalId } = await createProposal(data);
    const path = publicationPath(data.workspaceId, data.apiId, proposalId);
    const preview = await previewPublication(path, data.ownerId).expect(200);
    await db.update(apiOperationsTable).set({ summary: "A changed source summary" })
      .where(eq(apiOperationsTable.id, data.operationId));
    const staleSource = await request(app).post(path).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: preview.body.previewToken }).expect(409);
    expect(staleSource.body.code).toBe("SEMANTIC_MCP_PROPOSAL_STALE");
    expect(descriptors(await mcp(data.workspaceId, "tools/list", undefined, data.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");

    const oldVersion = await fixture();
    const old = await createProposal(oldVersion);
    await request(app).post(`/api/workspaces/${oldVersion.workspaceId}/apis/${oldVersion.apiId}/specifications`)
      .set(auth(oldVersion.ownerId)).send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Publication API", version: "2" },
          paths: { "/replacement": { get: { operationId: "replacement", responses: { "200": { description: "ok" } } } } },
        }),
      }).expect(201);
    const oldPath = publicationPath(oldVersion.workspaceId, oldVersion.apiId, old.proposalId);
    const noncurrent = await previewPublication(oldPath, oldVersion.ownerId).expect(409);
    expect(noncurrent.body.code).toBe("SEMANTIC_MCP_PROPOSAL_NOT_ACCEPTED");
    expect(descriptors(await mcp(oldVersion.workspaceId, "tools/list", undefined, oldVersion.ownerId).expect(200))).toEqual([]);

    const wrongRevision = await fixture();
    const revised = await createProposal(wrongRevision);
    await db.update(semanticProviderConfigsTable).set({
      credentialRevision: 2,
      testedRevision: 2,
    }).where(eq(semanticProviderConfigsTable.workspaceId, wrongRevision.workspaceId));
    const revisionResponse = await previewPublication(publicationPath(
      wrongRevision.workspaceId, wrongRevision.apiId, revised.proposalId,
    ), wrongRevision.ownerId).expect(409);
    expect(revisionResponse.body.code).toBe("SEMANTIC_MCP_PROPOSAL_STALE");
  });

  it("falls back immediately on credential rotation, reimport, and rollout disablement", async () => {
    const rotated = await fixture();
    const rotation = await createProposal(rotated);
    const rotationPath = publicationPath(rotated.workspaceId, rotated.apiId, rotation.proposalId);
    const rotationPreview = await previewPublication(rotationPath, rotated.ownerId).expect(200);
    await request(app).post(rotationPath).set(auth(rotated.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: rotationPreview.body.previewToken }).expect(200);
    await rotated.provider.saveKey(rotated.workspaceId, rotated.ownerId, `${secret}-rotated`);
    expect(descriptors(await mcp(rotated.workspaceId, "tools/list", undefined, rotated.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");
    const [afterRotation] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, rotation.proposalId));
    expect(afterRotation?.mcpPublishedAt).toBeNull();

    const reimported = await fixture();
    const importProposal = await createProposal(reimported);
    const importPath = publicationPath(reimported.workspaceId, reimported.apiId, importProposal.proposalId);
    const importPreview = await previewPublication(importPath, reimported.ownerId).expect(200);
    await request(app).post(importPath).set(auth(reimported.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: importPreview.body.previewToken }).expect(200);
    await request(app).post(`/api/workspaces/${reimported.workspaceId}/apis/${reimported.apiId}/specifications`)
      .set(auth(reimported.ownerId)).send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Publication API", version: "2" },
          paths: { "/new": { get: { operationId: "newOperation", responses: { "200": { description: "ok" } } } } },
        }),
      }).expect(201);
    expect(descriptors(await mcp(reimported.workspaceId, "tools/list", undefined, reimported.ownerId).expect(200))).toEqual([]);
    const [afterImport] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, importProposal.proposalId));
    expect(afterImport?.mcpPublishedAt).toBeNull();

    const disabled = await fixture();
    const rolloutProposal = await createProposal(disabled);
    const rolloutPath = publicationPath(disabled.workspaceId, disabled.apiId, rolloutProposal.proposalId);
    const rolloutPreview = await previewPublication(rolloutPath, disabled.ownerId).expect(200);
    await request(app).post(rolloutPath).set(auth(disabled.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: rolloutPreview.body.previewToken }).expect(200);
    process.env.SEMANTIC_PROVIDERS_ENABLED = "false";
    expect(descriptors(await mcp(disabled.workspaceId, "tools/list", undefined, disabled.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");
    const [stillPublished] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, rolloutProposal.proposalId));
    expect(stillPublished?.mcpPublishedAt).not.toBeNull();

    const staleMarker = await fixture();
    const staleProposal = await createProposal(staleMarker);
    const stalePath = publicationPath(staleMarker.workspaceId, staleMarker.apiId, staleProposal.proposalId);
    const stalePreview = await previewPublication(stalePath, staleMarker.ownerId).expect(200);
    await request(app).post(stalePath).set(auth(staleMarker.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: stalePreview.body.previewToken }).expect(200);
    await db.update(semanticAnalysisProposalsTable).set({ status: "stale" })
      .where(eq(semanticAnalysisProposalsTable.id, staleProposal.proposalId));
    expect(descriptors(await mcp(staleMarker.workspaceId, "tools/list", undefined, staleMarker.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");
    const [staleWithMarker] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, staleProposal.proposalId));
    expect(staleWithMarker?.status).toBe("stale");
    expect(staleWithMarker?.mcpPublishedAt).not.toBeNull();

    const failedTest = await fixture();
    const failedProposal = await createProposal(failedTest);
    const failedPath = publicationPath(failedTest.workspaceId, failedTest.apiId, failedProposal.proposalId);
    const failedPreview = await previewPublication(failedPath, failedTest.ownerId).expect(200);
    await request(app).post(failedPath).set(auth(failedTest.ownerId)).set("origin", sameOrigin)
      .send({ previewToken: failedPreview.body.previewToken }).expect(200);
    await db.update(semanticProviderConfigsTable).set({ lastTestOutcome: "failure" })
      .where(eq(semanticProviderConfigsTable.workspaceId, failedTest.workspaceId));
    expect(descriptors(await mcp(failedTest.workspaceId, "tools/list", undefined, failedTest.ownerId).expect(200))[0]?.description)
      .toBe("Imported operation description (unauthenticated)");
    const [publishedDespiteFailedTest] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, failedProposal.proposalId));
    expect(publishedDespiteFailedTest?.mcpPublishedAt).not.toBeNull();
  });
});
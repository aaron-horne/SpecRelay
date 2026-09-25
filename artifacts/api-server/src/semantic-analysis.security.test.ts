import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  auditEventsTable,
  db,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import { SemanticAnalysisService } from "./services/semantic-analysis";
import { SemanticProviderService } from "./services/semantic-providers";
import type { JevAnalysisJudgment, JevCandidate, JevOperationInput } from "./services/semantic-analysis-adapter";
import type { SemanticProviderAdapter } from "./services/semantic-provider-adapters";

process.env.SESSION_SECRET ??= "semantic-analysis-security-test-key";
const owner = `semantic-analysis-owner-${randomUUID()}`;
const sameOrigin = "http://127.0.0.1";
const secret = "semantic-analysis-credential-secret";
const previousEnabled = process.env.SEMANTIC_PROVIDERS_ENABLED;
const previousAllowlist = process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;

const auth = (userId: string) => ({ "x-test-user-id": userId });
const restoreFlags = () => {
  if (previousEnabled === undefined) delete process.env.SEMANTIC_PROVIDERS_ENABLED;
  else process.env.SEMANTIC_PROVIDERS_ENABLED = previousEnabled;
  if (previousAllowlist === undefined) delete process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
  else process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = previousAllowlist;
};

async function fixture(operationPath = "/records/{recordId}") {
  const ownerId = `${owner}-${randomUUID()}`;
  const workspaceResponse = await request(app).post("/api/workspaces")
    .set(auth(ownerId)).send({ name: `Manual Jev ${randomUUID()}` }).expect(201);
  const workspaceId = workspaceResponse.body.id as string;
  const apiResponse = await request(app).post(`/api/workspaces/${workspaceId}/apis`)
    .set(auth(ownerId)).send({ name: "Imported source" }).expect(201);
  const apiId = apiResponse.body.id as string;
  const imported = await request(app).post(`/api/workspaces/${workspaceId}/apis/${apiId}/specifications`)
    .set(auth(ownerId)).send({
      document: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Test API", version: "1" },
        servers: [{ url: "https://must-not-be-sent.invalid/private" }],
        paths: {
          [operationPath]: {
            get: {
              operationId: "getRecord",
              summary: "Read a record",
              description: "Read safely; api_key=leak-this https://private.invalid/path",
              parameters: [{ name: "recordId", in: "path", required: true, description: "Opaque record identifier" }],
              responses: { "200": { description: "A record was found" } },
            },
          },
        },
      }),
    }).expect(201);
  const operationId = imported.body.operations[0].id as string;

  process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
  process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS = workspaceId;
  const testAdapter: SemanticProviderAdapter = {
    async dispatch() {
      return { outcome: Promise.resolve("success") };
    },
  };
  const provider = new SemanticProviderService(testAdapter);
  await provider.saveKey(workspaceId, ownerId, secret);
  await provider.test(workspaceId, ownerId);
  await provider.setReady(workspaceId, ownerId, true);
  return { workspaceId, apiId, operationId, ownerId, provider };
}

function pendingJudgment() {
  let begin!: () => void;
  let finish!: (answer: JevAnalysisJudgment) => void;
  const begun = new Promise<void>((resolve) => { begin = resolve; });
  const judgment = new Promise<JevAnalysisJudgment>((resolve) => { finish = resolve; });
  return { begun, finish, begin, judgment };
}

function mcpTools(workspaceId: string, ownerId: string) {
  return request(app).post(`/api/workspaces/${workspaceId}/mcp`)
    .set(auth(ownerId))
    .set("accept", "application/json, text/event-stream")
    .set("mcp-protocol-version", "2026-07-28")
    .set("mcp-method", "tools/list")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "semantic-analysis-security-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  restoreFlags();
});

describe.sequential("manual Jev semantic analysis security", () => {
  it("requires OWNER, same-origin, rollout, Ready, and a successful current credential test", async () => {
    const data = await fixture();
    const endpoint = `/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}/semantic-analysis`;
    const memberId = `semantic-analysis-member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({ workspaceId: data.workspaceId, userId: memberId, role: "MEMBER" });
    const adapter = { dispatch: vi.fn(async () => ({
      judgment: Promise.resolve({ abstained: true, confidence: 1 } as JevAnalysisJudgment),
    })) };
    const service = new SemanticAnalysisService(adapter);
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, memberId))
      .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });

    await request(app).post(endpoint).set(auth(data.ownerId)).send({}).expect(403);
    await request(app).post(endpoint).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ operation: "caller supplied data" }).expect(400);
    process.env.SEMANTIC_PROVIDERS_ENABLED = "false";
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId))
      .rejects.toMatchObject({ status: 503, code: "SEMANTIC_PROVIDERS_DISABLED" });
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    await data.provider.setReady(data.workspaceId, data.ownerId, false);
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_ANALYSIS_NOT_READY" });
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });

  it("sends only bounded redacted operation fields and persists a source-grounded console overlay", async () => {
    const data = await fixture();
    let sentOperation: JevOperationInput | undefined;
    let sentCandidates: JevCandidate[] = [];
    await request(app).patch(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}`)
      .set(auth(data.ownerId)).send({ enabled: true }).expect(200);
    const toolsBefore = await mcpTools(data.workspaceId, data.ownerId).expect(200);
    const descriptorsBefore = toolsBefore.body.result.tools.map((tool: Record<string, unknown>) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const dispatch = vi.fn(async (_secret: string, operation: JevOperationInput, candidates: JevCandidate[]) => {
      sentOperation = operation;
      sentCandidates = candidates;
      return { judgment: Promise.resolve({
        abstained: false,
        candidateId: candidates[0]!.id,
        confidence: 0.91,
      } as JevAnalysisJudgment) };
    });
    const service = new SemanticAnalysisService({ dispatch });
    const result = await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("proposal");
    expect(result.proposal).toMatchObject({ status: "pending", confidence: 0.91, sourceField: "summary" });
    expect(sentOperation).toMatchObject({
      method: "GET",
      path: "/{segment}/{parameter}",
      summary: "Read a record",
    });
    const serializedInput = JSON.stringify({ sentOperation, sentCandidates });
    expect(serializedInput).not.toContain(secret);
    expect(serializedInput).not.toContain("must-not-be-sent.invalid");
    expect(serializedInput).not.toContain("private.invalid");
    expect(serializedInput).not.toContain("leak-this");
    expect(sentCandidates.every((candidate) => candidate.text.length <= 500)).toBe(true);

    const [operationBefore] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    const accepted = await service.decide(
      data.workspaceId, data.apiId, result.proposal!.id, data.ownerId, "accepted",
    );
    const [operationAfter] = await db.select().from(apiOperationsTable)
      .where(eq(apiOperationsTable.id, data.operationId));
    expect(accepted.status).toBe("accepted");
    expect(operationAfter?.enabled).toBe(operationBefore?.enabled);
    expect(operationAfter?.summary).toBe(operationBefore?.summary);
    const toolsAfter = await mcpTools(data.workspaceId, data.ownerId).expect(200);
    expect(toolsAfter.body.result.tools.map((tool: Record<string, unknown>) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))).toEqual(descriptorsBefore);
    const decisionAudit = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.proposal_accepted"),
    ));
    expect(decisionAudit).toHaveLength(1);
    const auditRows = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.proposal_created"),
    ));
    expect(JSON.stringify(auditRows)).not.toContain(secret);
    expect(JSON.stringify(auditRows)).not.toContain("leak-this");
  });

  it("never forwards literal route segments, including identity-like values", async () => {
    const data = await fixture("/people/123-45-6789/0123456789abcdef0123456789abcdef");
    const dispatch = vi.fn(async (_secret: string, operation: JevOperationInput, candidates: JevCandidate[]) => {
      const outbound = JSON.stringify({ operation, candidates });
      expect(operation.path).toBe("/{segment}/{segment}/{segment}");
      expect(outbound).not.toContain("123-45-6789");
      expect(outbound).not.toContain("0123456789abcdef0123456789abcdef");
      expect(outbound).not.toContain("people");
      return { judgment: Promise.resolve({ abstained: true, confidence: 0.9 } as JevAnalysisJudgment) };
    });
    await new SemanticAnalysisService({ dispatch }).analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("discards a typed judgment if OWNER access is revoked before persistence", async () => {
    const data = await fixture();
    const pending = pendingJudgment();
    const service = new SemanticAnalysisService({
      async dispatch() {
        pending.begin();
        return { judgment: pending.judgment };
      },
    });
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await pending.begun;
    await db.delete(workspaceMembershipsTable).where(and(
      eq(workspaceMembershipsTable.workspaceId, data.workspaceId),
      eq(workspaceMembershipsTable.userId, data.ownerId),
    ));
    pending.finish({ abstained: false, candidateId: "c1", confidence: 0.99 });
    await expect(analyzing).rejects.toMatchObject({ status: 404, code: "WORKSPACE_NOT_FOUND" });
    const proposals = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.workspaceId, data.workspaceId));
    expect(proposals).toHaveLength(0);
  });

  it("fails closed when the global gate is disabled after dispatch and before persistence", async () => {
    const data = await fixture();
    const pending = pendingJudgment();
    const dispatch = vi.fn(async () => {
      pending.begin();
      return { judgment: pending.judgment };
    });
    const service = new SemanticAnalysisService({ dispatch });
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await pending.begun;
    process.env.SEMANTIC_PROVIDERS_ENABLED = "false";
    pending.finish({ abstained: false, candidateId: "c1", confidence: 0.99 });
    await expect(analyzing).rejects.toMatchObject({ status: 503, code: "SEMANTIC_PROVIDERS_DISABLED" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const proposals = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.workspaceId, data.workspaceId));
    expect(proposals).toHaveLength(0);
    const outcomes = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.outcome"),
    ));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.metadata).toMatchObject({ outcome: "discarded", reasonCode: "SEMANTIC_PROVIDERS_DISABLED" });
  });

  it("fails closed when Ready is switched off after dispatch and before persistence", async () => {
    const data = await fixture();
    const pending = pendingJudgment();
    const dispatch = vi.fn(async () => {
      pending.begin();
      return { judgment: pending.judgment };
    });
    const analyzing = new SemanticAnalysisService({ dispatch })
      .analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await pending.begun;
    await data.provider.setReady(data.workspaceId, data.ownerId, false);
    pending.finish({ abstained: false, candidateId: "c1", confidence: 0.99 });
    await expect(analyzing).rejects.toMatchObject({ status: 409, code: "SEMANTIC_ANALYSIS_NOT_READY" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const proposals = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.workspaceId, data.workspaceId));
    expect(proposals).toHaveLength(0);
  });

  it("fails closed when the credential revision changes after dispatch and before persistence", async () => {
    const data = await fixture();
    const pending = pendingJudgment();
    const dispatch = vi.fn(async () => {
      pending.begin();
      return { judgment: pending.judgment };
    });
    const analyzing = new SemanticAnalysisService({ dispatch })
      .analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await pending.begun;
    const [before] = await db.select().from(semanticProviderConfigsTable)
      .where(eq(semanticProviderConfigsTable.workspaceId, data.workspaceId));
    await data.provider.saveKey(data.workspaceId, data.ownerId, `${secret}-replacement`);
    const [after] = await db.select().from(semanticProviderConfigsTable)
      .where(eq(semanticProviderConfigsTable.workspaceId, data.workspaceId));
    expect(after?.credentialRevision).toBe((before?.credentialRevision ?? 0) + 1);
    pending.finish({ abstained: false, candidateId: "c1", confidence: 0.99 });
    await expect(analyzing).rejects.toMatchObject({ status: 409, code: "SEMANTIC_ANALYSIS_NOT_READY" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const proposals = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.workspaceId, data.workspaceId));
    expect(proposals).toHaveLength(0);
  });

  it("audits rejection and allows only one dispatch for a reserved action within the rate window", async () => {
    const data = await fixture();
    const dispatch = vi.fn(async (_secret: string, _operation: JevOperationInput, candidates: JevCandidate[]) => ({
      judgment: Promise.resolve({
        abstained: false,
        candidateId: candidates[0]!.id,
        confidence: 0.9,
      } as JevAnalysisJudgment),
    }));
    const service = new SemanticAnalysisService({ dispatch });
    const result = await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await service.decide(data.workspaceId, data.apiId, result.proposal!.id, data.ownerId, "rejected");
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_ANALYSIS_RATE_LIMITED" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const rejected = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.proposal_rejected"),
    ));
    const reservations = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.reserved"),
    ));
    expect(rejected).toHaveLength(1);
    expect(reservations).toHaveLength(1);
  });

  it("does not accept a proposal made with an older Jev credential revision", async () => {
    const data = await fixture();
    const service = new SemanticAnalysisService({
      async dispatch(_secret, _operation, candidates) {
        return { judgment: Promise.resolve({ abstained: false, candidateId: candidates[0]!.id, confidence: 0.9 }) };
      },
    });
    const result = await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    await db.update(semanticProviderConfigsTable).set({
      credentialRevision: sql`${semanticProviderConfigsTable.credentialRevision} + 1`,
      testedRevision: sql`${semanticProviderConfigsTable.testedRevision} + 1`,
    }).where(eq(semanticProviderConfigsTable.workspaceId, data.workspaceId));
    await expect(service.decide(data.workspaceId, data.apiId, result.proposal!.id, data.ownerId, "accepted"))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROPOSAL_CREDENTIAL_CHANGED" });
    const [proposal] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, result.proposal!.id));
    expect(proposal?.status).toBe("pending");
  });

  it("automatically stales old-version proposals on reimport and rejects their acceptance", async () => {
    const data = await fixture();
    const service = new SemanticAnalysisService({
      async dispatch(_secret, _operation, candidates) {
        return { judgment: Promise.resolve({ abstained: false, candidateId: candidates[0]!.id, confidence: 0.9 }) };
      },
    });
    const result = await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    const proposalId = result.proposal!.id;
    await request(app).post(`/api/workspaces/${data.workspaceId}/apis/${data.apiId}/specifications`)
      .set(auth(data.ownerId)).send({
        document: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Test API", version: "2" },
          paths: { "/records/{recordId}": { get: {
            operationId: "getRecord",
            summary: "Updated record",
            responses: { "200": { description: "Updated" } },
          } } },
        }),
      }).expect(201);
    const [stale] = await db.select().from(semanticAnalysisProposalsTable)
      .where(eq(semanticAnalysisProposalsTable.id, proposalId));
    expect(stale?.status).toBe("stale");
    await expect(service.decide(data.workspaceId, data.apiId, proposalId, data.ownerId, "accepted"))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROPOSAL_STALE" });
  });

  it("rejects malformed TypeSafe Choice answers and never retries", async () => {
    const { JevSemanticAnalysisAdapter } = await import("./services/semantic-analysis-adapter");
    const adapter = new JevSemanticAnalysisAdapter();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        description_candidate: {
          type: "choice",
          choice: "invented",
          confidence: 0.95,
          probabilities: { c1: 0.95, abstain: 0.05, invented: 0 },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter.analyze(secret, {
      method: "GET", path: "/records/{id}", summary: null, description: null, parameters: [], responses: [],
    }, [{ id: "c1", sourceField: "summary", text: "source text" }])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
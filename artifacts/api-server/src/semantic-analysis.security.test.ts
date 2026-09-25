import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  semanticAnalysisDenialEventsTable,
  semanticAnalysisPreflightTokensTable,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
} from "@workspace/db";
import app from "./app";
import { SemanticAnalysisService } from "./services/semantic-analysis";
import { SemanticProviderService } from "./services/semantic-providers";
import { JevSemanticAnalysisAdapter, serializeJevRequest, type JevAnalysisJudgment, type JevCandidate, type JevOperationInput } from "./services/semantic-analysis-adapter";
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
              description: "Read a stored record using its identifier",
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

async function prepare(service: SemanticAnalysisService, data: Awaited<ReturnType<typeof fixture>>) {
  return service.prepare(data.workspaceId, data.apiId, data.operationId, data.ownerId);
}

async function analyzePrepared(service: SemanticAnalysisService, data: Awaited<ReturnType<typeof fixture>>) {
  const preflight = await prepare(service, data);
  return service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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
    const preflightEndpoint = `${endpoint}/preflight`;
    const memberId = `semantic-analysis-member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({ workspaceId: data.workspaceId, userId: memberId, role: "MEMBER" });
    const adapter = { dispatch: vi.fn(async () => ({
      judgment: Promise.resolve({ abstained: true, confidence: 1 } as JevAnalysisJudgment),
    })) };
    const service = new SemanticAnalysisService(adapter);
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, memberId, "unused", true))
      .rejects.toMatchObject({ status: 403, code: "OWNER_REQUIRED" });

    await request(app).post(endpoint).set(auth(data.ownerId)).send({}).expect(403);
    const prepared = await request(app).post(preflightEndpoint).set(auth(data.ownerId))
      .set("origin", sameOrigin).send({}).expect(200);
    expect(prepared.body).toMatchObject({
      preflightToken: expect.any(String),
      expiresAt: expect.any(String),
      payload: expect.any(Object),
    });
    await request(app).post(endpoint).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({}).expect(400);
    await request(app).post(endpoint).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ operation: "caller supplied data" }).expect(400);
    const preflight = await prepare(service, data);
    process.env.SEMANTIC_PROVIDERS_ENABLED = "false";
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true))
      .rejects.toMatchObject({ status: 503, code: "SEMANTIC_PROVIDERS_DISABLED" });
    process.env.SEMANTIC_PROVIDERS_ENABLED = "true";
    await data.provider.setReady(data.workspaceId, data.ownerId, false);
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_ANALYSIS_NOT_READY" });
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });

  it("audits route-level denials without recording rejected request content", async () => {
    const data = await fixture();
    const endpoint = `/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}/semantic-analysis`;
    const memberId = `semantic-analysis-member-${randomUUID()}`;
    await db.insert(workspaceMembershipsTable).values({ workspaceId: data.workspaceId, userId: memberId, role: "MEMBER" });
    await request(app).post(`${endpoint}/preflight`).set(auth(memberId)).set("origin", sameOrigin).send({}).expect(403);
    await request(app).post(endpoint).set(auth(data.ownerId)).send({ preflightToken: "untrusted" }).expect(403);
    await request(app).post(`${endpoint}/preflight`).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ operation: "never-store-this-doc" }).expect(400);
    await vi.waitFor(async () => {
      const rows = await db.select().from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, data.workspaceId),
        eq(auditEventsTable.eventType, "semantic_analysis.request_denied"),
      ));
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => (row.metadata as { reasonCategory?: string }).reasonCategory))
        .toEqual(expect.arrayContaining(["owner_required", "origin_invalid", "invalid_request"]));
      expect(JSON.stringify(rows)).not.toContain("never-store-this-doc");
      expect(JSON.stringify(rows)).not.toContain(secret);
    });
  });

  it("audits unauthenticated and unavailable-workspace analysis denials without target data or response leakage", async () => {
    const data = await fixture();
    const priorEvents = await db.select({ id: semanticAnalysisDenialEventsTable.id })
      .from(semanticAnalysisDenialEventsTable);
    const priorEventIds = new Set(priorEvents.map((event) => event.id));
    const base = `/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}/semantic-analysis`;
    const unauthenticatedPreflight = await request(app).post(`${base}/preflight`)
      .set(auth("__unauthenticated__")).send({});
    const unauthenticatedConfirmation = await request(app).post(base)
      .set(auth("__unauthenticated__")).send({});
    const malformedConfirmation = await request(app).post(base)
      .set(auth("__unauthenticated__"))
      .set("content-type", "application/json")
      .send("{");
    expect(unauthenticatedPreflight.status).toBe(401);
    expect(unauthenticatedConfirmation.status).toBe(401);
    expect(malformedConfirmation.status).toBe(400);

    const actor = `semantic-analysis-outsider-${randomUUID()}`;
    const nonmemberPreflight = await request(app).post(`${base}/preflight`).set(auth(actor)).send({});
    const nonmemberConfirmation = await request(app).post(base).set(auth(actor)).send({});
    const unknownWorkspaceId = randomUUID();
    const unknownTarget = `/api/workspaces/${unknownWorkspaceId}/apis/${randomUUID()}/operations/${randomUUID()}/semantic-analysis`;
    const unknownPreflight = await request(app).post(`${unknownTarget}/preflight`).set(auth(actor)).send({});
    const unknownConfirmation = await request(app).post(unknownTarget).set(auth(actor)).send({});
    for (const response of [nonmemberPreflight, unknownPreflight]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    }
    for (const response of [nonmemberConfirmation, unknownConfirmation]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    }

    const events = await db.select().from(semanticAnalysisDenialEventsTable);
    const newEvents = events.filter((event) => !priorEventIds.has(event.id));
    const unauthenticated = newEvents.filter((event) => event.reasonClass === "unauthenticated");
    expect(unauthenticated.map((event) => event.requestCategory).sort()).toEqual(["confirmation", "preflight"]);
    expect(unauthenticated.every((event) => event.actorId === null)).toBe(true);
    expect(newEvents.filter((event) => event.reasonClass === "request_rejected").map((event) => [
      event.actorId,
      event.requestCategory,
    ])).toEqual([[null, "confirmation"]]);
    const unavailable = newEvents.filter((event) => event.reasonClass === "workspace_unavailable");
    expect(unavailable.map((event) => [event.actorId, event.requestCategory]).sort())
      .toEqual([[actor, "confirmation"], [actor, "confirmation"], [actor, "preflight"], [actor, "preflight"]]);
    expect(JSON.stringify(events)).not.toContain(data.workspaceId);
    expect(JSON.stringify(events)).not.toContain(data.apiId);
    expect(JSON.stringify(events)).not.toContain(data.operationId);
    expect(JSON.stringify(events)).not.toContain(unknownWorkspaceId);
  });

  it("requires explicit no-sensitive-data confirmation before token use or reservation", async () => {
    const data = await fixture();
    const preflight = await prepare(new SemanticAnalysisService(), data);
    const endpoint = `/api/workspaces/${data.workspaceId}/apis/${data.apiId}/operations/${data.operationId}/semantic-analysis`;
    const priorDenials = await db.select({ id: semanticAnalysisDenialEventsTable.id })
      .from(semanticAnalysisDenialEventsTable)
      .where(eq(semanticAnalysisDenialEventsTable.reasonClass, "payload_confirmation_required"));
    const priorDenialIds = new Set(priorDenials.map((event) => event.id));
    const dispatch = vi.fn();
    await expect(new SemanticAnalysisService({ dispatch }).analyze(
      data.workspaceId,
      data.apiId,
      data.operationId,
      data.ownerId,
      preflight.preflightToken,
      false,
    )).rejects.toMatchObject({ status: 400, code: "SEMANTIC_ANALYSIS_CONFIRMATION_REQUIRED" });
    expect(dispatch).not.toHaveBeenCalled();
    const missing = await request(app).post(endpoint).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ preflightToken: preflight.preflightToken });
    const negative = await request(app).post(endpoint).set(auth(data.ownerId)).set("origin", sameOrigin)
      .send({ preflightToken: preflight.preflightToken, confirmedNoSensitiveData: false });
    expect(missing.status).toBe(400);
    expect(negative.status).toBe(400);
    expect(missing.body).toEqual(negative.body);
    const tokens = await db.select().from(semanticAnalysisPreflightTokensTable)
      .where(eq(semanticAnalysisPreflightTokensTable.workspaceId, data.workspaceId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumedAt).toBeNull();
    const reservations = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.reserved"),
    ));
    expect(reservations).toHaveLength(0);
    const denials = (await db.select().from(semanticAnalysisDenialEventsTable))
      .filter((event) => event.reasonClass === "payload_confirmation_required" && !priorDenialIds.has(event.id));
    expect(denials.map((event) => event.requestCategory)).toEqual(["confirmation", "confirmation", "confirmation"]);
    expect(JSON.stringify(denials)).not.toContain(preflight.preflightToken);
    expect(JSON.stringify(denials)).not.toContain(JSON.stringify(preflight.payload));
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
    const preflight = await prepare(service, data);
    const result = await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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

  it("returns the exact provider JSON body during no-dispatch preflight", async () => {
    const data = await fixture();
    let outboundBody = "";
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      outboundBody = String(init?.body);
      const sent = JSON.parse(outboundBody) as { questions: { description_candidate: { criteria: Record<string, string> } } };
      const choices = Object.keys(sent.questions.description_candidate.criteria);
      const probabilities = Object.fromEntries(choices.map((choice) => [
        choice, choice === "c1" ? 0.9 : choice === "abstain" ? 0.1 : 0,
      ]));
      return new Response(JSON.stringify({
        model: "jev-test",
        answers: { description_candidate: { type: "choice", choice: "c1", confidence: 0.9, probabilities } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new SemanticAnalysisService(new JevSemanticAnalysisAdapter());
    const preflight = await prepare(service, data);
    expect(fetchMock).not.toHaveBeenCalled();
    const storedTokens = await db.select().from(semanticAnalysisPreflightTokensTable)
      .where(eq(semanticAnalysisPreflightTokensTable.workspaceId, data.workspaceId));
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0]?.tokenHash).not.toBe(preflight.preflightToken);
    expect(JSON.stringify(storedTokens[0])).not.toContain(preflight.preflightToken);
    expect(JSON.stringify(storedTokens[0])).not.toContain(JSON.stringify(preflight.payload));
    expect(preflight.payload).toEqual(serializeJevRequest(
      (preflight.payload as { state: { operation: JevOperationInput } }).state.operation,
      ((preflight.payload as { state: { candidates: Array<{ id: string; text: string }> } }).state.candidates)
        .map((candidate) => ({ ...candidate, sourceField: "" })),
    ));
    await service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outboundBody).toBe(JSON.stringify(preflight.payload));
  });

  it("rejects unsafe source prose and audits only a denial category", async () => {
    const data = await fixture();
    await db.update(apiOperationsTable).set({ description: "credential=do-not-audit-this" })
      .where(eq(apiOperationsTable.id, data.operationId));
    const dispatch = vi.fn();
    const service = new SemanticAnalysisService({ dispatch });
    await expect(prepare(service, data)).rejects.toMatchObject({
      status: 400, code: "SEMANTIC_ANALYSIS_REDACTION_FAILED",
    });
    expect(dispatch).not.toHaveBeenCalled();
    const denied = await db.select().from(auditEventsTable).where(and(
      eq(auditEventsTable.workspaceId, data.workspaceId),
      eq(auditEventsTable.eventType, "semantic_analysis.preflight_denied"),
    ));
    expect(denied).toHaveLength(1);
    expect(denied[0]?.metadata).toMatchObject({ reasonCategory: "unsafe_source" });
    expect(JSON.stringify(denied)).not.toContain("do-not-audit-this");
  });

  it("binds candidate source fields to their original parameter and response indices", async () => {
    const data = await fixture();
    await db.update(apiOperationsTable).set({
      parameters: [
        { name: "unused", location: "query", required: false, schemaType: "string", description: null },
        { name: "second", location: "header", required: true, schemaType: "string", description: "Second safe parameter" },
      ],
      responses: [
        { statusCode: "204", description: null, contentTypes: [] },
        { statusCode: "201", description: "Second safe response", contentTypes: [] },
      ],
    }).where(eq(apiOperationsTable.id, data.operationId));
    let sourceFields: string[] = [];
    const service = new SemanticAnalysisService({
      async dispatch(_secret, _operation, candidates) {
        sourceFields = candidates.map((candidate) => candidate.sourceField);
        return { judgment: Promise.resolve({ abstained: true, confidence: 0.9 }) };
      },
    });
    await analyzePrepared(service, data);
    expect(sourceFields).toContain("parameter_description:1");
    expect(sourceFields).toContain("response_description:1");
    expect(sourceFields).not.toContain("parameter_description:0");
    expect(sourceFields).not.toContain("response_description:0");
  });

  it("stales proposals when their supporting source disappears or the document hash drifts", async () => {
    const data = await fixture();
    const service = new SemanticAnalysisService({
      async dispatch(_secret, _operation, candidates) {
        return { judgment: Promise.resolve({ abstained: false, candidateId: candidates[0]!.id, confidence: 0.9 }) };
      },
    });
    const result = await analyzePrepared(service, data);
    const proposalId = result.proposal!.id;
    await db.update(apiSpecVersionsTable).set({ documentHash: `drift-${randomUUID()}` })
      .where(eq(apiSpecVersionsTable.workspaceId, data.workspaceId));
    const listed = await service.list(data.workspaceId, data.apiId, data.operationId, data.ownerId);
    expect(listed.find((proposal) => proposal.id === proposalId)?.status).toBe("stale");
    await expect(service.decide(data.workspaceId, data.apiId, proposalId, data.ownerId, "accepted"))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROPOSAL_STALE" });

    const second = await fixture();
    const secondResult = await analyzePrepared(service, second);
    await db.update(apiOperationsTable).set({ summary: null })
      .where(eq(apiOperationsTable.id, second.operationId));
    const sourceMissing = await service.list(second.workspaceId, second.apiId, second.operationId, second.ownerId);
    expect(sourceMissing.find((proposal) => proposal.id === secondResult.proposal!.id)?.status).toBe("stale");
    await expect(service.decide(second.workspaceId, second.apiId, secondResult.proposal!.id, second.ownerId, "accepted"))
      .rejects.toMatchObject({ status: 409, code: "SEMANTIC_PROPOSAL_STALE" });
  });

  it("allows only one confirmation to consume a preflight token under a race", async () => {
    const data = await fixture();
    const dispatch = vi.fn(async (_secret: string, _operation: JevOperationInput, _candidates: JevCandidate[]) => ({
      judgment: Promise.resolve({ abstained: true, confidence: 0.9 } as JevAnalysisJudgment),
    }));
    const service = new SemanticAnalysisService({ dispatch });
    const preflight = await prepare(service, data);
    const attempts = await Promise.allSettled([
      service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true),
      service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
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
    await analyzePrepared(new SemanticAnalysisService({ dispatch }), data);
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
    const preflight = await prepare(service, data);
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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
    const preflight = await prepare(service, data);
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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
    const service = new SemanticAnalysisService({ dispatch });
    const preflight = await prepare(service, data);
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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
    const service = new SemanticAnalysisService({ dispatch });
    const preflight = await prepare(service, data);
    const analyzing = service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, preflight.preflightToken, true);
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
    const result = await analyzePrepared(service, data);
    await service.decide(data.workspaceId, data.apiId, result.proposal!.id, data.ownerId, "rejected");
    const nextPreflight = await prepare(service, data);
    await expect(service.analyze(data.workspaceId, data.apiId, data.operationId, data.ownerId, nextPreflight.preflightToken, true))
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
    const result = await analyzePrepared(service, data);
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
    const result = await analyzePrepared(service, data);
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
    const { judgment } = await adapter.dispatch(secret, {
      method: "GET", path: "/records/{id}", summary: null, description: null, parameters: [], responses: [],
    }, [{ id: "c1", sourceField: "summary", text: "source text" }]);
    await expect(judgment).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
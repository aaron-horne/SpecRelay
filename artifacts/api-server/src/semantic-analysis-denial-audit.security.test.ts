import { randomUUID } from "node:crypto";
import request from "supertest";
import { db, semanticAnalysisDenialEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { logger } from "./lib/logger";
import {
  recordSemanticAnalysisDenial,
  semanticAnalysisRequestCategory,
} from "./services/semantic-analysis-denial-audit";

const auth = (userId: string) => ({ "x-test-user-id": userId });

function semanticPath(workspaceId: string, apiId = randomUUID(), operationId = randomUUID()) {
  return `/api/workspaces/${workspaceId}/apis/${apiId}/operations/${operationId}/semantic-analysis`;
}

describe("semantic-analysis denial audit hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies preflight, confirmation exchange, and dispatch separately", () => {
    const base = semanticPath(randomUUID());
    expect(semanticAnalysisRequestCategory("POST", `${base}/preflight`)).toBe("preflight");
    expect(semanticAnalysisRequestCategory("POST", `${base}/confirm`)).toBe("confirmation");
    expect(semanticAnalysisRequestCategory("POST", base)).toBe("dispatch");
    expect(semanticAnalysisRequestCategory("GET", base)).toBeNull();
  });

  it("persists a dispatch denial under the dispatch category", async () => {
    const actor = `dispatch-outsider-${randomUUID()}`;
    const response = await request(app).post(semanticPath(randomUUID()))
      .set(auth(actor)).send({});
    expect(response.status).toBe(404);
    await vi.waitFor(async () => {
      const events = await db.select().from(semanticAnalysisDenialEventsTable)
        .where(eq(semanticAnalysisDenialEventsTable.actorId, actor));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        requestCategory: "dispatch",
        reasonClass: "workspace_unavailable",
      });
    });
  });

  it("returns indistinguishable 404s and audits malformed, unknown, and nonmember workspace IDs", async () => {
    const actorId = `audit-outsider-${randomUUID()}`;
    const validUnknown = randomUUID();
    const malformed = "not-a-workspace-id";
    const owned = await request(app).post("/api/workspaces").set(auth(`audit-owner-${randomUUID()}`))
      .send({ name: "Audit boundary workspace" }).expect(201);
    const existingWorkspace = owned.body.id as string;
    const unknownPath = semanticPath(validUnknown);
    const existingPath = semanticPath(existingWorkspace);
    const malformedResponse = await request(app).post(`${semanticPath(malformed)}/preflight`)
      .set(auth(actorId)).send({});
    const unknownResponse = await request(app).post(`${unknownPath}/preflight`)
      .set(auth(actorId)).send({});
    const nonmemberResponse = await request(app).post(`${existingPath}/preflight`)
      .set(auth(actorId)).send({});
    expect(malformedResponse.status).toBe(404);
    expect(malformedResponse.body).toEqual({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    expect(unknownResponse.status).toBe(malformedResponse.status);
    expect(unknownResponse.body).toEqual(malformedResponse.body);
    expect(nonmemberResponse.status).toBe(malformedResponse.status);
    expect(nonmemberResponse.body).toEqual(malformedResponse.body);

    const invalidEvents = await vi.waitFor(async () => {
      const events = await db.select().from(semanticAnalysisDenialEventsTable).where(eq(
        semanticAnalysisDenialEventsTable.actorId,
        actorId,
      ));
      expect(events).toHaveLength(3);
      return events;
    });
    expect(invalidEvents.map(({ requestCategory, reasonClass }) => [requestCategory, reasonClass]))
      .toEqual([
        ["preflight", "workspace_unavailable"],
        ["preflight", "workspace_unavailable"],
        ["preflight", "workspace_unavailable"],
      ]);
    expect(JSON.stringify(invalidEvents)).not.toContain(malformed);
    expect(JSON.stringify(invalidEvents)).not.toContain(validUnknown);
    expect(JSON.stringify(invalidEvents)).not.toContain(existingWorkspace);
    expect(JSON.stringify(invalidEvents)).not.toContain(unknownPath);
  });

  it("attempts parser-denial audit while retaining the same malformed-JSON response", async () => {
    const priorIds = new Set((await db.select({ id: semanticAnalysisDenialEventsTable.id })
      .from(semanticAnalysisDenialEventsTable)).map((event) => event.id));
    const path = `${semanticPath(randomUUID())}/confirm`;
    const response = await request(app).post(path)
      .set("content-type", "application/json").send("{");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Malformed JSON", code: "MALFORMED_JSON" });
    const event = await vi.waitFor(async () => {
      const rows = await db.select().from(semanticAnalysisDenialEventsTable);
      const newEvents = rows.filter((row) => !priorIds.has(row.id));
      expect(newEvents).toHaveLength(1);
      return newEvents[0];
    });
    expect(event).toMatchObject({
      actorId: null,
      requestCategory: "confirmation",
      reasonClass: "request_rejected",
    });
  });

  it("emits a privacy-limited structured fallback when durable audit persistence fails without changing the denial", async () => {
    const insertFailure = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("private database diagnostic must not reach the security log");
    });
    const fallback = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const category = "preflight" as const;
    const reason = "workspace_unavailable" as const;

    await recordSemanticAnalysisDenial(null, category, reason, {
      id: randomUUID(),
    } as never);
    expect(insertFailure).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    const [fields, message] = fallback.mock.calls[0]!;
    expect(fields).toMatchObject({
      requestCategory: category,
      reasonClass: reason,
      timestamp: expect.any(String),
    });
    expect(fields).not.toHaveProperty("actorId");
    expect(fields).not.toHaveProperty("workspaceId");
    expect(fields).not.toHaveProperty("payload");
    expect(message).toBe("Semantic-analysis denial audit persistence failed");
    expect(JSON.stringify(fields)).not.toContain("private database diagnostic");

    vi.restoreAllMocks();
    const failedInsert = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    const routeFallback = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const response = await request(app).post(`${semanticPath("malformed")}/preflight`)
      .set(auth(`audit-failure-${randomUUID()}`)).send({});
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    await vi.waitFor(() => expect(routeFallback).toHaveBeenCalled());
    expect(failedInsert).toHaveBeenCalled();
    const [fallbackFields] = routeFallback.mock.calls[0]!;
    expect(fallbackFields).toMatchObject({
      requestCategory: "preflight",
      reasonClass: "workspace_unavailable",
      timestamp: expect.any(String),
    });
    expect(JSON.stringify(fallbackFields)).not.toContain("malformed");
  });
});
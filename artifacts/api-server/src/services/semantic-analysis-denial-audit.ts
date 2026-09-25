import { db, semanticAnalysisDenialEventsTable } from "@workspace/db";
import type { Request } from "express";
import { logger } from "../lib/logger";

export type SemanticAnalysisRequestCategory = "preflight" | "confirmation" | "dispatch";
export type SemanticAnalysisDenialReason =
  | "unauthenticated"
  | "workspace_unavailable"
  | "payload_confirmation_required"
  | "request_rejected";

export function semanticAnalysisRequestCategory(
  method: string,
  path: string,
): SemanticAnalysisRequestCategory | null {
  if (method !== "POST") return null;
  const normalizedPath = (path.split("?")[0]!.startsWith("/api/")
    ? path.split("?")[0]!.slice(4)
    : path.split("?")[0]!).replace(/\/$/, "");
  if (!/^\/workspaces\/[^/]+\/apis\/[^/]+\/operations\/[^/]+\/semantic-analysis(?:\/(?:preflight|confirm))?\/?$/.test(normalizedPath)) {
    return null;
  }
  if (normalizedPath.endsWith("/preflight")) return "preflight";
  if (normalizedPath.endsWith("/confirm")) return "confirmation";
  return "dispatch";
}

export function semanticAnalysisDenialReason(statusCode: number): SemanticAnalysisDenialReason | null {
  if (statusCode === 401) return "unauthenticated";
  if (statusCode === 404) return "workspace_unavailable";
  if (statusCode >= 400 && statusCode < 500) return "request_rejected";
  return null;
}

function safeCorrelationId(req?: Request): string | undefined {
  const value = req?.id;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value);
  return /^[a-f0-9-]{36}$/i.test(normalized) ? normalized : undefined;
}

export async function recordSemanticAnalysisDenial(
  actorId: string | null,
  requestCategory: SemanticAnalysisRequestCategory,
  reasonClass: SemanticAnalysisDenialReason,
  req?: Request,
): Promise<void> {
  try {
    await db.insert(semanticAnalysisDenialEventsTable).values({
      actorId,
      requestCategory,
      reasonClass,
    });
  } catch {
    try {
      logger.warn({
        requestCategory,
        reasonClass,
        timestamp: new Date().toISOString(),
        ...(safeCorrelationId(req) ? { correlationId: safeCorrelationId(req) } : {}),
      }, "Semantic-analysis denial audit persistence failed");
    } catch {
      // Audit telemetry must not alter the caller-facing denial response.
    }
  }
}

export function auditSemanticAnalysisDenialResponse(
  req: Request,
  statusCode: number,
  actorId: string | null = null,
): void {
  const requestCategory = semanticAnalysisRequestCategory(req.method, req.originalUrl || req.path);
  const reasonClass = semanticAnalysisDenialReason(statusCode);
  if (!requestCategory || !reasonClass) return;
  void recordSemanticAnalysisDenial(actorId, requestCategory, reasonClass, req);
}

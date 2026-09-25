import { db, semanticAnalysisDenialEventsTable } from "@workspace/db";

export type SemanticAnalysisRequestCategory = "preflight" | "confirmation";
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
  const normalizedPath = (path.startsWith("/api/") ? path.slice(4) : path).replace(/\/$/, "");
  if (!/^\/workspaces\/[^/]+\/apis\/[^/]+\/operations\/[^/]+\/semantic-analysis(?:\/preflight)?\/?$/.test(normalizedPath)) {
    return null;
  }
  return normalizedPath.endsWith("/preflight") ? "preflight" : "confirmation";
}

export async function recordSemanticAnalysisDenial(
  actorId: string | null,
  requestCategory: SemanticAnalysisRequestCategory,
  reasonClass: SemanticAnalysisDenialReason,
): Promise<void> {
  try {
    await db.insert(semanticAnalysisDenialEventsTable).values({
      actorId,
      requestCategory,
      reasonClass,
    });
  } catch {
    // Internal audit failure must never alter the endpoint's external response.
  }
}
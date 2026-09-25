export interface JevOperationInput {
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  parameters: Array<{ location: string; required: boolean; schemaType?: string; description?: string }>;
  responses: Array<{ status: string; description?: string }>;
}

export interface JevCandidate {
  id: string;
  sourceField: string;
  text: string;
}

export type JevAnalysisJudgment =
  | { abstained: true; confidence: number }
  | { abstained: false; candidateId: string; confidence: number };

export interface SemanticAnalysisAdapter {
  dispatch(
    secret: string,
    operation: JevOperationInput,
    candidates: JevCandidate[],
  ): Promise<{ judgment: Promise<JevAnalysisJudgment> }>;
}

export function serializeJevRequest(operation: JevOperationInput, candidates: JevCandidate[]) {
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((candidate) => [candidate.id, candidate.text]),
  );
  criteria.abstain = "No candidate is sufficiently supported or suitable.";
  return {
    model: "jev-latest",
    state: { operation, candidates: candidates.map(({ id, text }) => ({ id, text })) },
    questions: {
      description_candidate: {
        type: "choice",
        instructions: {
          question: "Select which exact candidate text is the best concise human-readable description of this imported operation. Do not rewrite, infer missing facts, or create new text.",
          abstention: "Choose abstain when no candidate is clearly suitable or source-supported.",
        },
        criteria,
      },
    },
  };
}

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4_096;
const MAX_REQUEST_BYTES = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(Buffer.concat(chunks));
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseJudgment(body: string, candidates: JevCandidate[]): JevAnalysisJudgment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.model !== "string" || !parsed.model.trim() ||
      !isRecord(parsed.answers) || !isRecord(parsed.answers.description_candidate)) return null;
  const answer = parsed.answers.description_candidate;
  if (answer.type !== "choice" || typeof answer.choice !== "string" ||
      typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 || answer.confidence > 1 || !isRecord(answer.probabilities)) return null;
  const expected = new Set([...candidates.map((candidate) => candidate.id), "abstain"]);
  const actualKeys = Object.keys(answer.probabilities);
  if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key))) return null;
  let total = 0;
  for (const key of actualKeys) {
    const probability = answer.probabilities[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.02 || !expected.has(answer.choice)) return null;
  if (answer.choice === "abstain") return { abstained: true, confidence: answer.confidence };
  if (!candidates.some((candidate) => candidate.id === answer.choice)) return null;
  return { abstained: false, candidateId: answer.choice, confidence: answer.confidence };
}

export class JevSemanticAnalysisAdapter implements SemanticAnalysisAdapter {
  async dispatch(
    secret: string,
    operation: JevOperationInput,
    candidates: JevCandidate[],
  ): Promise<{ judgment: Promise<JevAnalysisJudgment> }> {
    if (candidates.length === 0 || candidates.length > 8) {
      throw new Error("No bounded description candidates");
    }
    const body = JSON.stringify(serializeJevRequest(operation, candidates));
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("Bounded analysis request exceeded its maximum size");
    }
    let response: Response;
    try {
      response = await fetch(JEV_URL, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
    } catch {
      throw new Error("Jev request failed");
    }
    return { judgment: this.classify(response, candidates) };
  }

  private async classify(response: Response, candidates: JevCandidate[]): Promise<JevAnalysisJudgment> {
    if (response.status === 401 || response.status === 403) throw new Error("Jev rejected the configured credential");
    if (!response.ok) throw new Error("Jev analysis request was not successful");
    const responseBody = await readBounded(response);
    if (responseBody === null) throw new Error("Jev response exceeded the maximum size or could not be read");
    const judgment = parseJudgment(responseBody, candidates);
    if (!judgment) throw new Error("Jev response did not satisfy the typed answer contract");
    return judgment;
  }
}
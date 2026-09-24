export type SemanticProviderTestOutcome =
  | "success"
  | "rejected"
  | "integration_error"
  | "inconclusive";

export interface SemanticProviderAdapter {
  test(secret: string): Promise<SemanticProviderTestOutcome>;
}

const JEV_TEST_URL = "https://api.typesafe.ai/v1/systemone";
const TEST_BODY = JSON.stringify({
  state: "The blue marker is present.",
  model: "jev-latest",
  questions: {
    marker_present: {
      type: "noul",
      instructions: "Does the sentence explicitly state that the blue marker is present?",
      criteria: {
        true: "The sentence explicitly states that the blue marker is present.",
        false: "The sentence does not explicitly state that the blue marker is present.",
      },
    },
  },
});
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_048;

async function readBoundedResponse(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let bytesRead = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(Buffer.concat(chunks));
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTypedNoulAnswer(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || typeof parsed.model !== "string" || !parsed.model.trim() ||
      !isRecord(parsed.answers) || !isRecord(parsed.answers.marker_present)) {
    return false;
  }
  const answer = parsed.answers.marker_present;
  return answer.type === "noul" &&
    typeof answer.noul === "number" &&
    Number.isFinite(answer.noul) &&
    answer.noul >= 0 && answer.noul <= 1;
}

export class JevSemanticProviderAdapter implements SemanticProviderAdapter {
  async test(secret: string): Promise<SemanticProviderTestOutcome> {
    let response: Response;
    try {
      response = await fetch(JEV_TEST_URL, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: TEST_BODY,
      });
    } catch (error) {
      return error instanceof Error && error.name === "TimeoutError"
        ? "inconclusive"
        : "integration_error";
    }

    if (response.status === 401 || response.status === 403) return "rejected";
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return "inconclusive";
    }
    if (response.status >= 200 && response.status < 300) {
      const body = await readBoundedResponse(response);
      if (body === null) return "inconclusive";
      return hasTypedNoulAnswer(body) ? "success" : "integration_error";
    }
    return "integration_error";
  }
}

export const jevSemanticProviderAdapter = new JevSemanticProviderAdapter();
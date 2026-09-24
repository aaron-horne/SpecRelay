export type SemanticProviderTestOutcome =
  | "success"
  | "rejected"
  | "integration_error"
  | "inconclusive";

export interface SemanticProviderAdapter {
  test(secret: string): Promise<SemanticProviderTestOutcome>;
}

const JEV_TEST_URL = "https://api.typesafe.ai/v1/systemone";
const TEST_BODY = JSON.stringify({ input: "Noul" });
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_048;

async function consumeBoundedResponse(response: Response): Promise<boolean> {
  if (!response.body) return true;
  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return true;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return false;
      }
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
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

    if (!(await consumeBoundedResponse(response))) return "inconclusive";
    if (response.status >= 200 && response.status < 300) return "success";
    if (response.status === 401 || response.status === 403) return "rejected";
    return "integration_error";
  }
}

export const jevSemanticProviderAdapter = new JevSemanticProviderAdapter();
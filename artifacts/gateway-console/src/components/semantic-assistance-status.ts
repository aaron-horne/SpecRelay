export const PHASE_1A_DESCRIPTION =
  "Configure and test the Jev connection here. Ready permits a workspace owner to request analysis explicitly from an operation page; it never starts automatic analysis or provider calls."

export function testCooldownSeconds(testCooldownUntil: string | null, now: number): number {
  const end = testCooldownUntil ? new Date(testCooldownUntil).getTime() : NaN
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0
}

export function testFailureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    if (error.status === 409 && "data" in error && typeof error.data === "object" &&
        error.data !== null && "code" in error.data &&
        error.data.code === "SEMANTIC_PROVIDER_TEST_RATE_LIMITED") {
      return "Test cooldown is active. Wait 30 seconds from the previous attempt and try again."
    }
    if (error.status === 503) return "Connection tests are not available yet."
  }
  return "Could not complete the test."
}
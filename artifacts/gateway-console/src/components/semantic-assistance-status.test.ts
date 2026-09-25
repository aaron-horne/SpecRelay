import { describe, expect, it } from "vitest"
import {
  PHASE_1A_DESCRIPTION,
  testCooldownSeconds,
  testFailureMessage,
} from "./semantic-assistance-status"

describe("Phase 1A semantic assistance status", () => {
  it("uses the durable audit-backed expiry even when lastTestedAt is unavailable", () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0)
    const until = new Date(now + 30_000).toISOString()
    expect(testCooldownSeconds(until, now)).toBe(30)
    expect(testCooldownSeconds(until, now + 4_500)).toBe(26)
    expect(testCooldownSeconds(until, now + 31_000)).toBe(0)
    expect(testCooldownSeconds(null, now)).toBe(0)
  })

  it("explains server-side cooldown on a 409 rather than reporting a generic failure", () => {
    expect(testFailureMessage({ status: 409, data: { code: "SEMANTIC_PROVIDER_TEST_RATE_LIMITED" } }))
      .toMatch(/cooldown is active/i)
    expect(testFailureMessage({ status: 409, data: { code: "SEMANTIC_PROVIDER_REVISION_CONFLICT" } }))
      .toBe("Could not complete the test.")
  })

  it("states that readiness never activates analysis or automatic egress in Phase 1A", () => {
    expect(PHASE_1A_DESCRIPTION).toMatch(/Ready permits a workspace owner to request analysis explicitly/)
    expect(PHASE_1A_DESCRIPTION).toMatch(/never starts automatic analysis or provider calls/)
  })
})
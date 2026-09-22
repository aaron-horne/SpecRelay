import { describe, expect, it } from "vitest";
import {
  resolveActorId,
  shouldInstallClerkMiddleware,
} from "./middlewares/auth";

describe("Clerk actor resolution", () => {
  it("omits Clerk middleware only in test mode", () => {
    expect(shouldInstallClerkMiddleware("test")).toBe(false);
    expect(shouldInstallClerkMiddleware("production")).toBe(true);
    expect(shouldInstallClerkMiddleware("development")).toBe(true);
    expect(shouldInstallClerkMiddleware(undefined)).toBe(true);
  });

  it("uses canonical auth.userId instead of sessionClaims.userId", () => {
    expect(resolveActorId(
      {
        userId: "clerk-canonical-user",
        sessionClaims: { userId: "attacker-from-claims" },
      },
      undefined,
      false,
    )).toBe("clerk-canonical-user");
  });

  it("only accepts the test identity override in test mode", () => {
    expect(resolveActorId(
      { userId: "clerk-canonical-user" },
      "test-user",
      false,
    )).toBe("clerk-canonical-user");
    expect(resolveActorId(
      { userId: "clerk-canonical-user" },
      "test-user",
      true,
    )).toBe("test-user");
  });

  it("requires Clerk identity and ignores test headers outside test mode", () => {
    expect(resolveActorId(
      { userId: null },
      "test-user",
      false,
    )).toBeUndefined();
    expect(resolveActorId(
      { userId: "clerk-production-user" },
      "test-user",
      false,
    )).toBe("clerk-production-user");
  });
});
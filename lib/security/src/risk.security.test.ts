import { describe, expect, it } from "vitest";
import { classifyOperationRisk } from "./index";

describe("deterministic operation risk classification", () => {
  it.each([
    ["GET", "READ_LIKE"],
    ["HEAD", "READ_LIKE"],
    ["POST", "WRITE"],
    ["PUT", "WRITE"],
    ["PATCH", "WRITE"],
    ["DELETE", "DESTRUCTIVE"],
    ["CONNECT", "UNKNOWN"],
  ] as const)("classifies %s as %s", (method, expected) => {
    expect(classifyOperationRisk({ method, path: "/items" })).toBe(expected);
  });

  it("only escalates heuristic risk", () => {
    expect(
      classifyOperationRisk({ method: "GET", path: "/accounts/{id}/delete" }),
    ).toBe("DESTRUCTIVE");
    expect(
      classifyOperationRisk({ method: "DELETE", path: "/items/list" }),
    ).toBe("DESTRUCTIVE");
  });
});
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const componentSource = readFileSync(fileURLToPath(new URL("./semantic-review.tsx", import.meta.url)), "utf8")

describe("semantic review privacy copy", () => {
  it("displays accurate exact-payload, scanner, and owner-verification copy", () => {
    expect(componentSource).toContain("{SEMANTIC_REVIEW_PRIVACY_COPY}")
    expect(componentSource).toMatch(/The JSON below is the exact request body prepared by the server/)
    expect(componentSource).toMatch(/credentials and authorization headers are not part of this JSON/)
    expect(componentSource).toMatch(/Automated scanning is a backstop, not a guarantee/)
    expect(componentSource).toMatch(/workspace owner, review this exact payload and confirm it contains no sensitive, customer, or session data before dispatch/)
  })
  it("blocks locally ineligible MCP publication and explains server-only listing requirements", () => {
    expect(componentSource).toContain("disabled={busy || locallyBlocked}")
    expect(componentSource).toContain("disabled={!preview || !canManage || busy || locallyBlocked}")
    expect(componentSource).toContain("policy ALLOW, execution approval, an executable HTTPS server")
    expect(componentSource).toContain("setError(errorMessage(cause, \"The MCP publication preview could not be prepared.")
  })
})
import { describe, expect, it } from "vitest"
import type { ApiOperation } from "@workspace/api-client-react"
import { localMcpListingBlockers } from "./mcp-publication-eligibility"

type ListingFields = Pick<ApiOperation, "enabled" | "method" | "requestBody" | "parameters">

const eligible: ListingFields = {
  enabled: true,
  method: "GET",
  requestBody: null,
  parameters: [],
}

describe("local MCP publication eligibility guidance", () => {
  it("does not block an eligible operation locally", () => {
    expect(localMcpListingBlockers(eligible)).toEqual([])
  })

  it("explains every locally visible reason a tool cannot be listed", () => {
    expect(localMcpListingBlockers({
      ...eligible,
      enabled: false,
      method: "POST",
      requestBody: { required: true, contentTypes: ["application/json"], description: null },
      parameters: [{ name: "Authorization", location: "header", required: true, description: null, schemaType: "string" }],
    })).toEqual([
      "Enable this operation.",
      "MCP tools/list only includes GET operations.",
      "Remove the request body from the imported operation.",
      "Only path and query parameters can be listed.",
    ])
  })
})
-- Console acceptance never publishes to MCP; only an explicit OWNER action
-- sets this nullable marker. A partial unique index prevents competing active
-- descriptions for the same versioned operation.
ALTER TABLE "semantic_analysis_proposals"
  ADD COLUMN IF NOT EXISTS "mcp_published_at" timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "semantic_analysis_proposals_one_mcp_publication_idx"
  ON "semantic_analysis_proposals" ("workspace_id", "specification_id", "operation_id")
  WHERE "mcp_published_at" IS NOT NULL;
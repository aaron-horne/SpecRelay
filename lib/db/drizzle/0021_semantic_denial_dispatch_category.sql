ALTER TABLE "semantic_analysis_denial_events"
  DROP CONSTRAINT IF EXISTS "semantic_analysis_denial_events_category_check",
  ADD CONSTRAINT "semantic_analysis_denial_events_category_check"
    CHECK ("request_category" IN ('preflight', 'confirmation', 'dispatch'));
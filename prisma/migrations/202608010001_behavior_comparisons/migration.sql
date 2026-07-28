ALTER TABLE "evidence_claims"
  ADD COLUMN "behavior_comparisons" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD CONSTRAINT "evidence_claims_behavior_comparisons_array"
    CHECK (jsonb_typeof("behavior_comparisons") = 'array');

ALTER TABLE "evidence_claims"
  ALTER COLUMN "behavior_comparisons" DROP DEFAULT;

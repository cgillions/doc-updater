-- Track GitHub App access independently from repository archive state.
ALTER TABLE "repository_registry"
ADD COLUMN "is_accessible" BOOLEAN NOT NULL DEFAULT true;

DROP INDEX "repository_registry_is_archived_is_paused_next_review_at_idx";

CREATE INDEX "repository_registry_scheduling_eligibility_idx"
ON "repository_registry"(
    "is_accessible",
    "is_archived",
    "is_paused",
    "next_review_at"
);

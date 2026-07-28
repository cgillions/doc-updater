-- Preserve terminal incomplete reviews while allowing a new execution attempt.
ALTER TABLE "review_jobs"
ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "review_jobs"
ADD CONSTRAINT "review_jobs_attempt_number_positive"
CHECK ("attempt_number" > 0);

CREATE INDEX "review_jobs_repository_review_attempt_idx"
ON "review_jobs"(
    "repository_id",
    "base_sha",
    "head_sha",
    "mode",
    "attempt_number"
);

-- Initial deterministic control-plane schema.
CREATE TYPE "ReviewJobMode" AS ENUM ('INCREMENTAL', 'RECONCILIATION');
CREATE TYPE "ReviewJobStatus" AS ENUM ('PENDING', 'LEASED', 'COMPLETED', 'FAILED');
CREATE TYPE "ReviewLeaseOutcome" AS ENUM ('COMPLETED', 'FAILED', 'RECOVERED');

CREATE TABLE "repository_registry" (
    "id" UUID NOT NULL,
    "github_repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "default_branch_head_sha" TEXT NOT NULL,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "next_review_at" TIMESTAMPTZ(3),
    "last_inventory_refresh_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "repository_registry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repository_registry_github_id_not_empty" CHECK (length("github_repository_id") > 0),
    CONSTRAINT "repository_registry_full_name_format" CHECK ("repository_full_name" ~ '^[^/]+/[^/]+$'),
    CONSTRAINT "repository_registry_default_branch_not_empty" CHECK (length("default_branch") > 0),
    CONSTRAINT "repository_registry_head_sha_format" CHECK ("default_branch_head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);

CREATE TABLE "repository_cursors" (
    "repository_id" UUID NOT NULL,
    "last_successfully_reviewed_sha" TEXT,
    "last_successfully_reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "repository_cursors_pkey" PRIMARY KEY ("repository_id"),
    CONSTRAINT "repository_cursors_sha_format" CHECK (
        "last_successfully_reviewed_sha" IS NULL OR
        "last_successfully_reviewed_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    ),
    CONSTRAINT "repository_cursors_review_fields_consistent" CHECK (
        ("last_successfully_reviewed_sha" IS NULL) = ("last_successfully_reviewed_at" IS NULL)
    )
);

CREATE TABLE "review_job_claim_invocations" (
    "id" UUID NOT NULL,
    "worker_id" TEXT NOT NULL,
    "requested_limit" INTEGER NOT NULL,
    "lease_duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_job_claim_invocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_job_claim_invocations_worker_not_empty" CHECK (length("worker_id") > 0),
    CONSTRAINT "review_job_claim_invocations_limit_bounded" CHECK ("requested_limit" BETWEEN 1 AND 100),
    CONSTRAINT "review_job_claim_invocations_lease_positive" CHECK ("lease_duration_ms" > 0)
);

CREATE TABLE "review_jobs" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "claim_invocation_id" UUID,
    "base_sha" TEXT,
    "head_sha" TEXT NOT NULL,
    "mode" "ReviewJobMode" NOT NULL,
    "deduplication_key" TEXT NOT NULL,
    "status" "ReviewJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_token" UUID,
    "last_lease_token" UUID,
    "last_lease_outcome" "ReviewLeaseOutcome",
    "lease_expires_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "last_failure_code" TEXT,
    "last_failure_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "review_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_jobs_base_sha_format" CHECK ("base_sha" IS NULL OR "base_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CONSTRAINT "review_jobs_head_sha_format" CHECK ("head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CONSTRAINT "review_jobs_attempt_count_nonnegative" CHECK ("attempt_count" >= 0),
    CONSTRAINT "review_jobs_lease_owner_not_empty" CHECK ("lease_owner" IS NULL OR length("lease_owner") > 0),
    CONSTRAINT "review_jobs_previous_lease_consistent" CHECK (
        ("last_lease_token" IS NULL) = ("last_lease_outcome" IS NULL)
    ),
    CONSTRAINT "review_jobs_state_consistent" CHECK (
        ("status" = 'PENDING' AND "lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NULL AND "failed_at" IS NULL)
        OR
        ("status" = 'LEASED' AND "lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "completed_at" IS NULL AND "failed_at" IS NULL)
        OR
        ("status" = 'COMPLETED' AND "lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL AND "failed_at" IS NULL AND "last_lease_outcome" = 'COMPLETED')
        OR
        ("status" = 'FAILED' AND "lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NULL AND "failed_at" IS NOT NULL AND "last_lease_outcome" = 'FAILED')
    )
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "review_job_id" UUID,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_id" TEXT,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_event_type_not_empty" CHECK (length("event_type") > 0),
    CONSTRAINT "audit_events_idempotency_key_not_empty" CHECK (length("idempotency_key") > 0)
);

CREATE UNIQUE INDEX "repository_registry_github_repository_id_key" ON "repository_registry"("github_repository_id");
CREATE UNIQUE INDEX "repository_registry_repository_full_name_key" ON "repository_registry"("repository_full_name");
CREATE INDEX "repository_registry_is_archived_is_paused_next_review_at_idx" ON "repository_registry"("is_archived", "is_paused", "next_review_at");
CREATE UNIQUE INDEX "review_jobs_deduplication_key_key" ON "review_jobs"("deduplication_key");
CREATE INDEX "review_jobs_status_available_at_created_at_idx" ON "review_jobs"("status", "available_at", "created_at");
CREATE INDEX "review_jobs_status_lease_expires_at_idx" ON "review_jobs"("status", "lease_expires_at");
CREATE INDEX "review_jobs_claim_invocation_id_status_idx" ON "review_jobs"("claim_invocation_id", "status");
CREATE INDEX "review_jobs_repository_id_created_at_idx" ON "review_jobs"("repository_id", "created_at");
CREATE UNIQUE INDEX "audit_events_idempotency_key_key" ON "audit_events"("idempotency_key");
CREATE INDEX "audit_events_repository_id_created_at_idx" ON "audit_events"("repository_id", "created_at");
CREATE INDEX "audit_events_review_job_id_created_at_idx" ON "audit_events"("review_job_id", "created_at");

ALTER TABLE "repository_cursors" ADD CONSTRAINT "repository_cursors_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_claim_invocation_id_fkey" FOREIGN KEY ("claim_invocation_id") REFERENCES "review_job_claim_invocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repository_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_review_job_id_fkey" FOREIGN KEY ("review_job_id") REFERENCES "review_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

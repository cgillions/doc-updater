CREATE TYPE "RoadieScopeStatus" AS ENUM (
  'PENDING',
  'RESOLVED',
  'REPO_ONLY'
);

ALTER TABLE "repository_registry"
  ADD COLUMN "roadie_scope_status" "RoadieScopeStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "component_ref" TEXT,
  ADD COLUMN "system_ref" TEXT,
  ADD COLUMN "owner_ref" TEXT,
  ADD COLUMN "slack_channel_id" TEXT,
  ADD COLUMN "documentation_scope" JSONB,
  ADD COLUMN "catalog_revision" TEXT,
  ADD COLUMN "configuration_hash" TEXT,
  ADD COLUMN "roadie_diagnostics" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "last_roadie_refresh_at" TIMESTAMPTZ(3);

ALTER TABLE "repository_registry"
  ADD CONSTRAINT "repository_registry_roadie_diagnostics_array_check"
    CHECK (jsonb_typeof("roadie_diagnostics") = 'array'),
  ADD CONSTRAINT "repository_registry_roadie_scope_consistency_check"
    CHECK (
      (
        "roadie_scope_status" = 'PENDING'
        AND "component_ref" IS NULL
        AND "system_ref" IS NULL
        AND "owner_ref" IS NULL
        AND "slack_channel_id" IS NULL
        AND "documentation_scope" IS NULL
        AND "configuration_hash" IS NULL
        AND "last_roadie_refresh_at" IS NULL
      )
      OR (
        "roadie_scope_status" = 'REPO_ONLY'
        AND "component_ref" IS NULL
        AND "system_ref" IS NULL
        AND "owner_ref" IS NULL
        AND "slack_channel_id" IS NULL
        AND "documentation_scope" IS NULL
        AND "configuration_hash" IS NULL
        AND "last_roadie_refresh_at" IS NOT NULL
      )
      OR (
        "roadie_scope_status" = 'RESOLVED'
        AND "component_ref" IS NOT NULL
        AND "system_ref" IS NOT NULL
        AND "owner_ref" IS NOT NULL
        AND "slack_channel_id" IS NOT NULL
        AND "documentation_scope" IS NOT NULL
        AND "configuration_hash" ~ '^[0-9a-f]{64}$'
        AND "last_roadie_refresh_at" IS NOT NULL
      )
    );

CREATE INDEX "repository_registry_roadie_scope_status_idx"
  ON "repository_registry"("roadie_scope_status");

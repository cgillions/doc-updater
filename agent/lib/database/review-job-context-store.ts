import {
  reviewJobContextSchema,
  type ReviewJobContext,
} from "../domain/review-jobs/review-job-context.ts";
import type { PrismaClient } from "./generated/client.ts";

/**
 * Loads the immutable baseline and resolved scope for one active review job.
 *
 * The lease token and queue internals remain private to the dispatcher.
 */
export class ReviewJobContextStore {
  private readonly database: PrismaClient;

  constructor(database: PrismaClient) {
    this.database = database;
  }

  /**
   * Loads a currently leased job whose repository still has trusted scope.
   *
   * @returns Validated model-safe context, or `null` if the job is unavailable.
   * @throws If persisted scope violates the application contract.
   */
  async loadActive(
    reviewJobId: string,
    now: Date = new Date(),
  ): Promise<ReviewJobContext | null> {
    const job = await this.database.reviewJob.findFirst({
      where: {
        id: reviewJobId,
        status: "LEASED",
        leaseExpiresAt: { gt: now },
        repository: {
          isAccessible: true,
          isArchived: false,
          isPaused: false,
          roadieScopeStatus: "RESOLVED",
        },
      },
      select: {
        id: true,
        mode: true,
        baseSha: true,
        headSha: true,
        repository: {
          select: {
            id: true,
            repositoryFullName: true,
            defaultBranch: true,
            componentRef: true,
            systemRef: true,
            ownerRef: true,
            slackChannelId: true,
            catalogRevision: true,
            configurationHash: true,
            documentationScope: true,
          },
        },
      },
    });
    if (!job) {
      return null;
    }

    return reviewJobContextSchema.parse({
      reviewJobId: job.id,
      mode: job.mode,
      baseSha: job.baseSha,
      headSha: job.headSha,
      repository: {
        id: job.repository.id,
        fullName: job.repository.repositoryFullName,
        defaultBranch: job.repository.defaultBranch,
      },
      roadie: {
        componentRef: job.repository.componentRef,
        systemRef: job.repository.systemRef,
        ownerRef: job.repository.ownerRef,
        slackChannelId: job.repository.slackChannelId,
        catalogRevision: job.repository.catalogRevision,
        configurationHash: job.repository.configurationHash,
      },
      documentationScope: job.repository.documentationScope,
    });
  }
}

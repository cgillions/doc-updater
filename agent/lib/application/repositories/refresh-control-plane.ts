import type { RepositoryInventorySyncResult } from "./synchronize-repository-inventory.ts";
import {
  createLogger,
  durationMs,
  type Logger,
} from "../../observability/logger.ts";

/** Repository selected for one bounded Roadie scope refresh. */
export interface RoadieRefreshCandidate {
  repositoryId: string;
}

/** Selects new, unresolved, or stale repositories for Roadie refresh. */
export interface RoadieRefreshCandidateSource {
  listRoadieRefreshCandidates(input: {
    limit: number;
    staleBefore: Date;
  }): Promise<RoadieRefreshCandidate[]>;
}

/** Refresh controls independent from review-job dispatch limits. */
export interface ScheduledControlPlaneRefreshConfig {
  roadieRefreshLimit: number;
  roadieRefreshIntervalMs: number;
}

/** Observable result of one scheduled control-plane refresh. */
export interface ScheduledControlPlaneRefreshResult
  extends RepositoryInventorySyncResult {
  roadieCandidateCount: number;
  roadieRefreshedCount: number;
  roadieFailedRepositoryIds: string[];
}

/** Dependencies required to refresh trusted scheduling state. */
export interface ScheduledControlPlaneRefresherOptions {
  inventory: {
    synchronize(
      refreshedAt: Date,
    ): Promise<RepositoryInventorySyncResult>;
  };
  candidates: RoadieRefreshCandidateSource;
  roadie: {
    synchronize(repositoryId: string, refreshedAt: Date): Promise<unknown>;
  };
  config: ScheduledControlPlaneRefreshConfig;
  logger?: Logger;
}

/**
 * Refreshes the complete GitHub inventory, then a bounded Roadie batch.
 *
 * GitHub failure aborts the invocation because the installation inventory is
 * the access boundary. Roadie failures are isolated so one repository cannot
 * block unrelated repositories that still have a fresh trusted projection.
 */
export class ScheduledControlPlaneRefresher {
  private readonly options: ScheduledControlPlaneRefresherOptions;
  private readonly logger: Logger;

  constructor(options: ScheduledControlPlaneRefresherOptions) {
    this.options = options;
    this.logger = options.logger ?? createLogger("control-plane-refresh");
  }

  async refresh(
    refreshedAt: Date = new Date(),
  ): Promise<ScheduledControlPlaneRefreshResult> {
    const startedAt = process.hrtime.bigint();
    this.logger.info("control plane refresh started", {
      refreshedAt: refreshedAt.toISOString(),
      roadieRefreshIntervalMs: this.options.config.roadieRefreshIntervalMs,
      roadieRefreshLimit: this.options.config.roadieRefreshLimit,
    });
    const inventory = await this.options.inventory.synchronize(refreshedAt);
    this.logger.info("GitHub inventory synchronized", { ...inventory });
    const candidates = (
      await this.options.candidates.listRoadieRefreshCandidates({
        limit: this.options.config.roadieRefreshLimit,
        staleBefore: new Date(
          refreshedAt.getTime() -
            this.options.config.roadieRefreshIntervalMs,
        ),
      })
    ).slice(0, this.options.config.roadieRefreshLimit);
    const failedRepositoryIds: string[] = [];
    let refreshedCount = 0;
    this.logger.info("Roadie refresh candidates loaded", {
      candidateCount: candidates.length,
      repositoryIds: candidates.map(({ repositoryId }) => repositoryId),
    });

    for (const candidate of candidates) {
      try {
        await this.options.roadie.synchronize(
          candidate.repositoryId,
          refreshedAt,
        );
        refreshedCount += 1;
        this.logger.info("Roadie scope synchronized", {
          repositoryId: candidate.repositoryId,
        });
      } catch {
        failedRepositoryIds.push(candidate.repositoryId);
        this.logger.warn("Roadie scope synchronization failed", {
          repositoryId: candidate.repositoryId,
        });
      }
    }

    const result = {
      ...inventory,
      roadieCandidateCount: candidates.length,
      roadieRefreshedCount: refreshedCount,
      roadieFailedRepositoryIds: failedRepositoryIds,
    };
    this.logger.info("control plane refresh completed", {
      ...result,
      durationMs: durationMs(startedAt),
    });
    return result;
  }
}

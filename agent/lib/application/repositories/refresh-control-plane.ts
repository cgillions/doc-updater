import type { RepositoryInventorySyncResult } from "./synchronize-repository-inventory.ts";

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

  constructor(options: ScheduledControlPlaneRefresherOptions) {
    this.options = options;
  }

  async refresh(
    refreshedAt: Date = new Date(),
  ): Promise<ScheduledControlPlaneRefreshResult> {
    const inventory = await this.options.inventory.synchronize(refreshedAt);
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

    for (const candidate of candidates) {
      try {
        await this.options.roadie.synchronize(
          candidate.repositoryId,
          refreshedAt,
        );
        refreshedCount += 1;
      } catch {
        failedRepositoryIds.push(candidate.repositoryId);
      }
    }

    return {
      ...inventory,
      roadieCandidateCount: candidates.length,
      roadieRefreshedCount: refreshedCount,
      roadieFailedRepositoryIds: failedRepositoryIds,
    };
  }
}

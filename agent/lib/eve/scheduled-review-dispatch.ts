import type { ScheduleHandlerArgs } from "eve/schedules";

import { ScheduledControlPlaneRefresher } from "../application/repositories/refresh-control-plane.ts";
import { RoadieScopeResolver } from "../application/repositories/resolve-roadie-scope.ts";
import { RepositoryInventorySynchronizer } from "../application/repositories/synchronize-repository-inventory.ts";
import { RepositoryRoadieScopeSynchronizer } from "../application/repositories/synchronize-roadie-scope.ts";
import { ReviewJobDispatcher } from "../application/review-jobs/dispatch-review-jobs.ts";
import { DueReviewJobEnqueuer } from "../application/review-jobs/enqueue-due-reviews.ts";
import { loadControlPlaneRefreshConfig } from "../config/control-plane-refresh-config.ts";
import { loadReviewDispatchConfig } from "../config/review-dispatch-config.ts";
import { createDatabaseClient } from "../database/client.ts";
import { RepositoryRegistryStore } from "../database/repository-registry-store.ts";
import { RepositoryReviewStore } from "../database/repository-review-store.ts";
import { RepositoryScopeStore } from "../database/repository-scope-store.ts";
import { ReviewJobStore } from "../database/review-job-store.ts";
import {
  createGitHubAppAccessTokenProvider,
  GitHubControlPlaneClient,
} from "../github/control-plane-client.ts";
import {
  RoadieCatalogClient,
} from "../roadie/catalog-client.ts";
import { createLogger, durationMs } from "../observability/logger.ts";
import { createSlackReviewSessionReceiver } from "./review-session-receiver.ts";

const logger = createLogger("scheduled-review-dispatch");

/**
 * Composes one scheduled dispatch against the production control plane.
 *
 * The database client remains invocation-scoped and is closed after all
 * initial repository turns settle.
 */
export async function runScheduledReviewDispatch(
  args: Pick<ScheduleHandlerArgs, "receive" | "appAuth">,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const database = createDatabaseClient();
  try {
    const invocationTime = new Date();
    logger.info("scheduled review dispatch started", {
      invocationTime: invocationTime.toISOString(),
    });
    const refreshConfig = loadControlPlaneRefreshConfig();
    const registry = new RepositoryRegistryStore(database);
    const scopes = new RepositoryScopeStore(database);
    const inventory = new RepositoryInventorySynchronizer(
      new GitHubControlPlaneClient({
        getAccessToken: createGitHubAppAccessTokenProvider(
          refreshConfig.githubConnectorId,
        ),
      }),
      registry,
    );
    const roadie = new RepositoryRoadieScopeSynchronizer(
      scopes,
      new RoadieScopeResolver(
        new RoadieCatalogClient({
          getAccessToken: async () => refreshConfig.roadieApiToken,
          apiBaseUrl: refreshConfig.roadieApiBaseUrl,
        }),
      ),
    );
    const refreshResult = await new ScheduledControlPlaneRefresher({
      inventory,
      candidates: scopes,
      roadie,
      config: refreshConfig,
    }).refresh(invocationTime);
    if (refreshResult.roadieFailedRepositoryIds.length > 0) {
      logger.warn("Roadie scope refresh had failures", {
        failedRepositoryIds: refreshResult.roadieFailedRepositoryIds,
      });
    }

    const queue = new ReviewJobStore(database);
    const repositories = new RepositoryReviewStore(database, {
      roadieFreshAfter: new Date(
        invocationTime.getTime() -
          refreshConfig.roadieScopeMaxAgeMs,
      ),
    });
    const dispatcher = new ReviewJobDispatcher({
      enqueuer: new DueReviewJobEnqueuer(repositories, queue),
      queue,
      routes: repositories,
      receiver: createSlackReviewSessionReceiver(
        args.receive,
        args.appAuth,
      ),
      config: loadReviewDispatchConfig(),
    });
    const dispatchResult = await dispatcher.dispatch();
    logger.info("scheduled review dispatch completed", {
      ...dispatchResult,
      durationMs: durationMs(startedAt),
    });
  } catch (error) {
    logger.error("scheduled review dispatch failed", {
      durationMs: durationMs(startedAt),
      errorMessage:
        error instanceof Error ? error.message : "Unknown dispatch failure.",
    });
    throw error;
  } finally {
    await database.$disconnect();
    logger.info("scheduled review dispatch database disconnected");
  }
}

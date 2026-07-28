import type { ScheduleHandlerArgs } from "eve/schedules";

import { ReviewJobDispatcher } from "../application/review-jobs/dispatch-review-jobs.ts";
import { DueReviewJobEnqueuer } from "../application/review-jobs/enqueue-due-reviews.ts";
import { loadReviewDispatchConfig } from "../config/review-dispatch-config.ts";
import { createDatabaseClient } from "../database/client.ts";
import { RepositoryReviewStore } from "../database/repository-review-store.ts";
import { ReviewJobStore } from "../database/review-job-store.ts";
import { createSlackReviewSessionReceiver } from "./review-session-receiver.ts";

/**
 * Composes one scheduled dispatch against the production control plane.
 *
 * The database client remains invocation-scoped and is closed after all
 * initial repository turns settle.
 */
export async function runScheduledReviewDispatch(
  args: Pick<ScheduleHandlerArgs, "receive" | "appAuth">,
): Promise<void> {
  const database = createDatabaseClient();
  try {
    const queue = new ReviewJobStore(database);
    const repositories = new RepositoryReviewStore(database);
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
    await dispatcher.dispatch();
  } finally {
    await database.$disconnect();
  }
}

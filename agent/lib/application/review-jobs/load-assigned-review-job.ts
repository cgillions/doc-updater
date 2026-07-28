import type { ReviewJobContext } from "../../domain/review-jobs/review-job-context.ts";

/** Minimal authenticated principal shape used by the job loader. */
export interface ReviewSessionPrincipal {
  authenticator: string;
  principalId: string;
  principalType: string;
  attributes: Readonly<Record<string, string | readonly string[]>>;
}

/** Session auth snapshot supplied by Eve tool context. */
export interface ReviewSessionAuth {
  current: ReviewSessionPrincipal | null;
  initiator: ReviewSessionPrincipal | null;
}

/** Persistence boundary for active job context. */
export interface ActiveReviewJobContextSource {
  loadActive(reviewJobId: string): Promise<ReviewJobContext | null>;
}

/** Raised when a session was not created by the trusted schedule. */
export class UntrustedReviewSessionError extends Error {
  constructor() {
    super("The active session is not bound to a trusted review job.");
    this.name = "UntrustedReviewSessionError";
  }
}

/** Raised when a bound job is no longer active or eligible. */
export class AssignedReviewJobUnavailableError extends Error {
  constructor(reviewJobId: string) {
    super(`Assigned review job ${reviewJobId} is no longer available.`);
    this.name = "AssignedReviewJobUnavailableError";
  }
}

/**
 * Loads the job selected by trusted schedule auth, never by model input.
 *
 * The durable initiator remains the app principal if a human later resumes
 * the Slack session, while `auth.current` changes to that human.
 */
export class AssignedReviewJobLoader {
  private readonly source: ActiveReviewJobContextSource;

  constructor(source: ActiveReviewJobContextSource) {
    this.source = source;
  }

  /**
   * Resolves and loads the job ID from the session initiator attributes.
   *
   * @returns Validated immutable job and repository scope.
   */
  async load(auth: ReviewSessionAuth): Promise<ReviewJobContext> {
    const reviewJobId = resolveAssignedReviewJobId(auth);

    const context = await this.source.loadActive(reviewJobId);
    if (!context) {
      throw new AssignedReviewJobUnavailableError(reviewJobId);
    }
    return context;
  }
}

/**
 * Resolves the opaque job ID from the durable Eve app initiator.
 *
 * `auth.current` is intentionally ignored because it can become a Slack user
 * on later turns.
 *
 * @returns The UUID assigned by the deterministic schedule.
 * @throws {UntrustedReviewSessionError} If the session is not schedule-bound.
 */
export function resolveAssignedReviewJobId(
  auth: ReviewSessionAuth,
): string {
  const initiator = auth.initiator;
  const reviewJobId = initiator?.attributes.reviewJobId;
  if (
    initiator?.authenticator !== "app" ||
    initiator.principalId !== "eve:app" ||
    initiator.principalType !== "runtime" ||
    typeof reviewJobId !== "string" ||
    !isUuid(reviewJobId)
  ) {
    throw new UntrustedReviewSessionError();
  }
  return reviewJobId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

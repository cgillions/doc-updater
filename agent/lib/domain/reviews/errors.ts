/** Raised when a review record conflicts with its assigned job or scope. */
export class ReviewRecordConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRecordConflictError";
  }
}

/** Raised when the assigned review job is no longer available for mutation. */
export class ReviewRecordUnavailableError extends Error {
  constructor(reviewJobId: string) {
    super(`Review job ${reviewJobId} is no longer active.`);
    this.name = "ReviewRecordUnavailableError";
  }
}

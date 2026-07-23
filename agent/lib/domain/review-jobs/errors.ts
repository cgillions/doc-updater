/** Raised when a requested review job does not exist. */
export class ReviewJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Review job ${jobId} does not exist.`);
    this.name = "ReviewJobNotFoundError";
  }
}

/** Raised when a transition is attempted with a stale or incorrect lease. */
export class ReviewJobLeaseConflictError extends Error {
  constructor(jobId: string) {
    super(`Review job ${jobId} is not held by the supplied lease.`);
    this.name = "ReviewJobLeaseConflictError";
  }
}

/** Raised when an existing claim ID is reused with different parameters. */
export class ReviewJobClaimConflictError extends Error {
  constructor(claimId: string) {
    super(`Review job claim ${claimId} was already used with different parameters.`);
    this.name = "ReviewJobClaimConflictError";
  }
}

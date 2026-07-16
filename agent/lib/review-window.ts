const REVIEW_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

export type ReviewWindow = {
  start: string;
  end: string;
  mergedSearchDate: string;
};

export function createReviewWindow(now: Date): ReviewWindow {
  const start = new Date(now.getTime() - REVIEW_WINDOW_MILLISECONDS);

  return {
    start: start.toISOString(),
    end: now.toISOString(),
    mergedSearchDate: start.toISOString().slice(0, 10),
  };
}

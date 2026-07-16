import assert from "node:assert/strict";
import test from "node:test";

import { createReviewWindow } from "./review-window.ts";

test("creates an exact 24-hour UTC review window", () => {
  const window = createReviewWindow(new Date("2026-07-16T10:30:45.000Z"));

  assert.deepEqual(window, {
    start: "2026-07-15T10:30:45.000Z",
    end: "2026-07-16T10:30:45.000Z",
    mergedSearchDate: "2026-07-15",
  });
});

test("returns a fresh object for each review window", () => {
  const firstWindow = createReviewWindow(new Date("2026-07-16T10:30:45.000Z"));
  const secondWindow = createReviewWindow(new Date("2026-07-16T10:30:45.000Z"));

  assert.notEqual(firstWindow, secondWindow);
});

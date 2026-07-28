import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs } from "eve/schedules";

import slack from "../../channels/slack.ts";
import type { ReviewSessionReceiver } from "../application/review-jobs/dispatch-review-jobs.ts";

const DIAGNOSTIC_MESSAGE =
  "Load the repository review assigned to this session and report its " +
  "diagnostic status. Do not assess drift or create artifacts.";

/**
 * Adapts Eve's proactive Slack receive contract to the review dispatcher.
 *
 * The returned receiver waits for the initial diagnostic turn to settle so a
 * successful delivery is not mistaken for a successfully completed turn.
 */
export function createSlackReviewSessionReceiver(
  receive: ScheduleHandlerArgs["receive"],
  appAuth: ScheduleHandlerArgs["appAuth"],
): ReviewSessionReceiver {
  return {
    async start({ reviewJobId, slackChannelId }) {
      const session = await receive(slack, {
        message: DIAGNOSTIC_MESSAGE,
        target: { channelId: slackChannelId },
        auth: {
          ...appAuth,
          attributes: { reviewJobId },
        },
      });
      await waitForInitialTurn(session);
      return { sessionId: session.id };
    },
  };
}

async function waitForInitialTurn(session: Session): Promise<void> {
  const stream = await session.getEventStream();
  const reader = stream.getReader();
  try {
    for (;;) {
      const event = await reader.read();
      if (event.done) {
        throw new Error(
          `Review session ${session.id} ended before its turn settled.`,
        );
      }
      if (
        event.value.type === "session.waiting" ||
        event.value.type === "session.completed"
      ) {
        return;
      }
      if (
        event.value.type === "turn.failed" ||
        event.value.type === "session.failed"
      ) {
        throw new Error(failureMessage(event.value.data));
      }
    }
  } finally {
    await reader.cancel();
  }
}

function failureMessage(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }
  return "The repository review session failed.";
}

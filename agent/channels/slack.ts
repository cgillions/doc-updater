import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  slackChannel,
  type SlackChannelEvents,
} from "eve/channels/slack";

const APPROVAL_CONTEXT_OPEN = "<slack_approval_context>";
const APPROVAL_CONTEXT_CLOSE = "</slack_approval_context>";

type CompletedSlackMessage = Parameters<
  NonNullable<SlackChannelEvents["message.completed"]>
>[0];

interface SlackMessageDelivery {
  state: {
    pendingToolCallMessage?: string | null;
  };
  thread: {
    post(message: string): Promise<unknown>;
    startTyping(status?: string): Promise<unknown>;
  };
}

/**
 * Posts approval context only when the same assistant step requests a tool.
 *
 * Eve binds the first proactive post as the Slack thread root. Keeping the
 * default input-requested handler then places its resumable HITL card in that
 * thread without recreating Eve's callback protocol.
 */
export async function handleCompletedSlackMessage(
  event: Pick<CompletedSlackMessage, "finishReason" | "message">,
  delivery: SlackMessageDelivery,
): Promise<void> {
  delivery.state.pendingToolCallMessage = null;

  const approvalContext = extractApprovalContext(event.message);
  if (event.finishReason === "tool-calls") {
    if (approvalContext !== null) {
      await delivery.thread.post(approvalContext);
      return;
    }

    delivery.state.pendingToolCallMessage = firstNonEmptyLine(event.message);
    return;
  }

  if (approvalContext !== null) {
    return;
  }

  if (event.message) {
    await delivery.thread.post(event.message);
    return;
  }

  await delivery.thread.startTyping();
}

function extractApprovalContext(message: string | null): string | null {
  if (message === null) {
    return null;
  }

  const trimmedMessage = message.trim();
  if (
    !trimmedMessage.startsWith(APPROVAL_CONTEXT_OPEN) ||
    !trimmedMessage.endsWith(APPROVAL_CONTEXT_CLOSE)
  ) {
    return null;
  }

  const context = trimmedMessage
    .slice(APPROVAL_CONTEXT_OPEN.length, -APPROVAL_CONTEXT_CLOSE.length)
    .trim();
  return context.length > 0 ? context : null;
}

function firstNonEmptyLine(message: string | null): string | null {
  if (message === null) {
    return null;
  }

  for (const line of message.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length > 0) {
      return trimmedLine;
    }
  }

  return null;
}

/** Production Slack edge using the existing Vercel Connect client. */
export default slackChannel({
  credentials: connectSlackCredentials("slack/docia"),
  events: {
    "message.completed": handleCompletedSlackMessage,
  },
});

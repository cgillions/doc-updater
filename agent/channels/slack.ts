import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  describeActionRequests,
  slackChannel,
  type SlackChannelEvents,
} from "eve/channels/slack";

import { createDatabaseClient } from "../lib/database/client.ts";
import { ConfluencePageUpdateStore } from "../lib/database/confluence-page-update-store.ts";
import { RepositoryPullRequestStore } from "../lib/database/repository-pull-request-store.ts";
import {
  loadSlackApprovalDetails,
  SLACK_APPROVAL_DETAILS_UNAVAILABLE,
  type SlackApprovalAction,
  type SlackApprovalDetailsReader,
} from "../lib/eve/slack-approval-details.ts";
import {
  resolveAssignedReviewJobId,
  type ReviewSessionAuth,
} from "../lib/application/review-jobs/load-assigned-review-job.ts";

const APPROVAL_CONTEXT_OPEN = "<slack_approval_context>";
const APPROVAL_CONTEXT_CLOSE = "</slack_approval_context>";

type CompletedSlackMessage = Parameters<
  NonNullable<SlackChannelEvents["message.completed"]>
>[0];
type ActionsRequestedEvent = Parameters<
  NonNullable<SlackChannelEvents["actions.requested"]>
>[0];
type ActionsRequestedChannel = Parameters<
  NonNullable<SlackChannelEvents["actions.requested"]>
>[1];
type ActionsRequestedContext = Parameters<
  NonNullable<SlackChannelEvents["actions.requested"]>
>[2];

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

/**
 * Preserves Eve's default action status while adding trusted context before
 * the native approval card is posted by Eve's input-requested handler.
 */
export async function handleSlackActionsRequested(
  event: ActionsRequestedEvent,
  channel: Pick<ActionsRequestedChannel, "state" | "thread">,
  context: Pick<ActionsRequestedContext, "session">,
  reader: SlackApprovalDetailsReader,
): Promise<void> {
  const pendingToolCallMessage = channel.state.pendingToolCallMessage;
  channel.state.pendingToolCallMessage = null;
  await channel.thread.startTyping(
    pendingToolCallMessage ?? describeActionRequests(event.actions),
  );

  const approvalActions = event.actions.filter(
    (action): action is typeof action & SlackApprovalAction =>
      action.kind === "tool-call" &&
      (action.toolName === "create_repository_pull_request" ||
        action.toolName === "publish_confluence_page_update"),
  );
  if (approvalActions.length === 0) {
    return;
  }

  const reviewJobId = resolveAssignedReviewJobId(
    context.session.auth as ReviewSessionAuth,
  );
  const details = await loadSlackApprovalDetails(
    approvalActions,
    reviewJobId,
    reader,
  );
  for (const message of details) {
    await channel.thread.post(message);
  }
}

async function handleProductionActionsRequested(
  event: ActionsRequestedEvent,
  channel: ActionsRequestedChannel,
  context: ActionsRequestedContext,
): Promise<void> {
  const hasApprovalAction = event.actions.some(
    (action) =>
      action.kind === "tool-call" &&
      (action.toolName === "create_repository_pull_request" ||
        action.toolName === "publish_confluence_page_update"),
  );
  if (!hasApprovalAction) {
    await handleDefaultActionsRequested(event, channel);
    return;
  }

  const database = createDatabaseClient();
  try {
    await handleSlackActionsRequested(event, channel, context, {
      loadRepositoryProposal(reviewJobId, proposalDigest) {
        return new RepositoryPullRequestStore(database).loadProposal(
          reviewJobId,
          proposalDigest,
        );
      },
      loadConfluenceProposal(reviewJobId, proposalDigest) {
        return new ConfluencePageUpdateStore(database).loadProposal(
          reviewJobId,
          proposalDigest,
        );
      },
    });
  } catch {
    await handleDefaultActionsRequested(event, channel);
    await channel.thread.post(SLACK_APPROVAL_DETAILS_UNAVAILABLE);
  } finally {
    await database.$disconnect();
  }
}

async function handleDefaultActionsRequested(
  event: ActionsRequestedEvent,
  channel: Pick<ActionsRequestedChannel, "state" | "thread">,
): Promise<void> {
  const pendingToolCallMessage = channel.state.pendingToolCallMessage;
  channel.state.pendingToolCallMessage = null;
  await channel.thread.startTyping(
    pendingToolCallMessage ?? describeActionRequests(event.actions),
  );
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
    "actions.requested": handleProductionActionsRequested,
    "message.completed": handleCompletedSlackMessage,
  },
});

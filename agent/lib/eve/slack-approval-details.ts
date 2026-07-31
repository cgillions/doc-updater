import type { ConfluenceDraftProposal } from "../database/confluence-draft-store.ts";
import type { RepositoryPullRequestProposal } from "../application/repositories/create-repository-pull-request.ts";
import {
  createRepositoryPullRequestInputSchema,
  publishConfluencePageUpdateInputSchema,
} from "../domain/reviews/review-records.ts";

export interface SlackApprovalAction {
  kind: string;
  toolName?: string;
  input?: unknown;
}

export interface SlackApprovalDetailsReader {
  loadRepositoryProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<RepositoryPullRequestProposal | null>;
  loadConfluenceProposal(
    reviewJobId: string,
    proposalDigest: string,
  ): Promise<ConfluenceDraftProposal | null>;
}

export const SLACK_APPROVAL_DETAILS_UNAVAILABLE =
  ":warning: I could not verify the stored proposal details for this approval. Please do not approve until the proposal can be reloaded.";

/**
 * Loads approval summaries from the same trusted proposals used by the
 * side-effecting tools. The model supplies only the digest; all displayed
 * target and safety details come from persistence.
 */
export async function loadSlackApprovalDetails(
  actions: readonly SlackApprovalAction[],
  reviewJobId: string,
  reader: SlackApprovalDetailsReader,
): Promise<string[]> {
  const messages: string[] = [];
  for (const action of actions) {
    if (action.kind !== "tool-call" || !action.toolName) {
      continue;
    }

    if (action.toolName === "create_repository_pull_request") {
      const parsed = createRepositoryPullRequestInputSchema.safeParse(
        action.input,
      );
      if (!parsed.success) {
        continue;
      }
      const proposal = await reader.loadRepositoryProposal(
        reviewJobId,
        parsed.data.proposalDigest,
      );
      if (proposal) {
        messages.push(formatRepositoryPullRequestDetails(proposal));
      } else {
        messages.push(SLACK_APPROVAL_DETAILS_UNAVAILABLE);
      }
      continue;
    }

    if (action.toolName === "publish_confluence_page_update") {
      const parsed = publishConfluencePageUpdateInputSchema.safeParse(
        action.input,
      );
      if (!parsed.success) {
        continue;
      }
      const proposal = await reader.loadConfluenceProposal(
        reviewJobId,
        parsed.data.proposalDigest,
      );
      if (proposal) {
        messages.push(formatConfluencePageUpdateDetails(proposal));
      } else {
        messages.push(SLACK_APPROVAL_DETAILS_UNAVAILABLE);
      }
    }
  }
  return messages;
}

export function formatRepositoryPullRequestDetails(
  proposal: RepositoryPullRequestProposal,
): string {
  const lineCount = proposal.content.length === 0
    ? 0
    : proposal.content.split(/\r?\n/u).length;
  return [
    "*Approval details — create repository pull request*",
    `• Repository: ${code(proposal.repositoryFullName)}`,
    `• File: ${code(proposal.path)}`,
    `• Base branch: ${code(proposal.defaultBranch)}`,
    `• Change: apply the reviewed documentation replacement (${lineCount} lines).`,
    "• Effect: creates one pull request only; it does not merge or publish the change.",
  ].join("\n");
}

export function formatConfluencePageUpdateDetails(
  proposal: ConfluenceDraftProposal,
): string {
  const pageLabel = proposal.pageTitle ??
    `${proposal.target.siteId}/${proposal.target.pageId}`;
  const page = proposal.pageUrl
    ? `<${proposal.pageUrl}|${slackText(pageLabel)}>`
    : code(pageLabel);
  return [
    "*Approval details — publish Confluence page update*",
    `• Page: ${page}`,
    `• Current version: ${proposal.target.version}`,
    "• Change: replace one exact content fragment with the reviewed documentation update.",
    "• Effect: publishes one new page version, preserves unrelated content, and refuses to write if the page changed or an unpublished draft exists.",
  ].join("\n");
}

function code(value: string): string {
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

function slackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

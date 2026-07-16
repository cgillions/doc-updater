import type { InputRequest } from "eve/client";
import {
  Actions,
  Button,
  Card,
  CardText,
  type ButtonElement,
  type CardElement,
} from "eve/channels/slack";

const CREATE_PULL_REQUEST_TOOL = "github__create_pull_request";
const HITL_ACTION_PREFIX = "eve_input:";
const HITL_FREEFORM_ACTION_PREFIX = "eve_input_freeform:";
const MAX_CHANGE_SUMMARIES = 3;
const MAX_CHANGE_SUMMARY_LENGTH = 180;

export function buildInputRequestCard(request: InputRequest): CardElement {
  const isPullRequestApproval = request.action.toolName === CREATE_PULL_REQUEST_TOOL;

  return Card({
    title: isPullRequestApproval ? "Documentation PR approval" : "Input required",
    children: [
      CardText(
        isPullRequestApproval
          ? formatPullRequestApproval(request.action.input)
          : request.prompt,
      ),
      ...buildActions(request),
    ],
  });
}

function formatPullRequestApproval(input: InputRequest["action"]["input"]): string {
  const owner = readString(input.owner);
  const repo = readString(input.repo);
  const title = readString(input.title);
  const body = readString(input.body);
  const repository = formatRepository(owner, repo);
  const changes = body ? extractChangeSummaries(body) : [];

  if (changes.length > 0) {
    return [
      `I want to open a PR in ${repository} so that I can:`,
      ...changes.map((change) => `• ${change}`),
      ...(title ? ["", `*PR title:* ${escapeSlackText(title)}`] : []),
    ].join("\n");
  }

  if (title) {
    return `I want to open a PR in ${repository} so that I can apply “${escapeSlackText(title)}”.`;
  }

  return `I want to open a documentation PR in ${repository}.`;
}

function formatRepository(
  owner: string | undefined,
  repo: string | undefined,
): string {
  if (!owner || !repo) {
    return "the configured repository";
  }

  const repositoryName = `${owner}/${repo}`;
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return `<${url}|${escapeSlackText(repositoryName)}>`;
}

function extractChangeSummaries(body: string): string[] {
  const changesSection = body.match(
    /^### Changes Made\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/imu,
  )?.[1];

  if (!changesSection) {
    return [];
  }

  return changesSection
    .split(/\r?\n/u)
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/u.exec(line)?.[1])
    .filter((change): change is string => Boolean(change))
    .slice(0, MAX_CHANGE_SUMMARIES)
    .map((change) =>
      escapeSlackText(change.slice(0, MAX_CHANGE_SUMMARY_LENGTH).trim()),
    );
}

function buildActions(request: InputRequest): CardElement["children"] {
  const options = approvalOptionsFirst(request.options ?? []);

  if (options.length === 0) {
    if (request.allowFreeform === false) {
      return [];
    }

    return [
      Actions([
        Button({
          id: `${HITL_FREEFORM_ACTION_PREFIX}${request.requestId}`,
          label: "Type your answer",
          style: "primary",
          value: request.requestId,
        }),
      ]),
    ];
  }

  const buttons: ButtonElement[] = options.map((option, index) =>
    Button({
      id: `${HITL_ACTION_PREFIX}${request.requestId}:button:${index}`,
      label: option.id === "approve" ? "Allow" : option.label,
      style: option.id === "approve" ? "primary" : option.style,
      value: option.id,
    }),
  );

  return [Actions(buttons)];
}

function approvalOptionsFirst(options: NonNullable<InputRequest["options"]>) {
  const approve = options.find((option) => option.id === "approve");
  const deny = options.find((option) => option.id === "deny");

  if (!approve || !deny) {
    return options;
  }

  return [
    deny,
    approve,
    ...options.filter((option) => option !== deny && option !== approve),
  ];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

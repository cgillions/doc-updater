import { getToken } from "@vercel/connect";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://api.githubcopilot.com/mcp/",
  description: "GitHub repositories, commits, pull requests, issues, and code search.",
  auth: {
    principalType: "app",
    getToken: async () => ({
      token: await getToken("github/docia-gh", {
        subject: { type: "app" },
      }),
    }),
  },
  tools: {
    allow: [
      "get_commit",
      "get_file_contents",
      "get_label",
      "get_latest_release",
      "get_release_by_tag",
      "get_tag",
      "issue_read",
      "list_branches",
      "list_commits",
      "list_issue_fields",
      "list_issue_types",
      "list_issues",
      "list_pull_requests",
      "list_releases",
      "list_repository_collaborators",
      "list_tags",
      "pull_request_read",
      "search_code",
      "search_commits",
      "search_issues",
      "search_pull_requests",
      "search_repositories",
      "search_users",
    ],
  },
  approval: ctx => {
    if (ctx.toolName === "github__list_commits") return "user-approval"
    return "approved";
  }
});

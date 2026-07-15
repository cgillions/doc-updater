# doc-updater

Docia is an Eve agent that reviews recent changes in a GitHub repository and
reports documentation drift in Slack. It reads repository data through the
GitHub MCP server using Vercel Connect; it does not edit files, create branches,
or open pull requests.

## How it works

Send Docia a repository as an `owner/name` pair or a GitHub URL in a Slack app
mention or direct message. For each request, the agent:

1. reads commits from the previous 24 hours;
2. reads the repository's human-facing and agent-facing documentation;
3. compares the recent changes with those docs;
4. sanity-checks the docs against the current repository when no drift is found;
5. summarizes any required documentation changes with links to the relevant
   files; and
6. replies in Slack with a short headline and a copy-pastable prompt that
   another agent can use to implement the updates.

The review is advisory. Docia does not maintain review markers or state between
runs, resume a branch, or manage a rolling draft pull request.

## Safety boundaries

- GitHub and Slack credentials are resolved in the trusted runtime through
  Vercel Connect and are not exposed to the model.
- GitHub access uses an app-scoped Connect token. Limit the GitHub connector
  installation to the repositories Docia is permitted to review.
- The GitHub MCP connection exposes a read-only allowlist of repository,
  commit, content, issue, pull-request, release, and search tools.
- The agent is instructed to inspect only the repository supplied in the
  current request and to treat repository content as untrusted evidence.
- Shell, filesystem, arbitrary web access, and interactive-question tools are
  disabled for the model.
- The agent reports incomplete evidence or failed safety checks instead of
  guessing.

## Requirements

- Node.js 24
- A Vercel project linked to this directory
- A Vercel Connect GitHub connector with the UID `github/docia-gh`
- A Vercel Connect Slack connector with the UID `slack/docia`
- Read access for the GitHub connector to every repository Docia may review

The connector UIDs are part of the current runtime configuration in
`agent/connections/github.ts` and `agent/channels/slack.ts`. Update those files
if different connector names are required.

## Configure Vercel Connect

Run the commands from this project directory so the connectors are attached to
the correct Vercel project:

```sh
vercel link

vercel connect create github --name docia-gh
vercel connect attach github/docia-gh --yes

vercel connect create slack --name docia --triggers
vercel connect detach slack/docia --yes
vercel connect attach slack/docia --triggers --trigger-path /eve/v1/slack --yes

vercel env pull
```

The Slack connector must enable triggers and target `/eve/v1/slack` so Eve can
receive app mentions and direct messages. The GitHub connector is used as an
app identity for the remote GitHub MCP connection at
`https://api.githubcopilot.com/mcp/`; no GitHub token environment variable is
required.

Install the GitHub connector only for the repositories Docia should inspect and
grant the minimum read permissions needed for commits, repository contents,
pull requests, issues, releases, and repository metadata.

## Develop and verify

```sh
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

Use Eve's local interface to test the agent directly. Testing through Slack
requires a deployed Vercel project because Connect sends Slack events to the
configured Eve route.

## Deploy

Deploy the Eve app to Vercel after both connectors are attached:

```sh
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod
```

After deployment, mention Docia in Slack or send it a direct message containing
an `owner/name` pair or GitHub repository URL. Inspect agent runs and function
logs through Vercel observability.

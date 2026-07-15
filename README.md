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
- Permission to create or link a Vercel project
- Permission to create Vercel Connect connectors for the selected Vercel team
- Permission to install an app in the target Slack workspace
- Permission to install a GitHub App on each GitHub account or organization that
  owns a repository Docia will review

The setup below creates the two connector UIDs expected by the current runtime:
`github/docia-gh` and `slack/docia`. Those values are hard-coded in
`agent/connections/github.ts` and `agent/channels/slack.ts`; update both the
code and the commands below if an environment must use different names.

## Set up a new environment

Vercel Connect has three separate pieces of setup:

1. **Link this checkout to the Vercel project that will run Docia.** Run
   `npx eve link`, select the owning Vercel team and project, and let Eve pull
   the project's local OIDC credential. This creates `.vercel/project.json`,
   which tells later `vercel connect` commands which project to configure.
2. **Create the Slack and GitHub connectors and attach them to that project.**
   Create `slack/docia` and `github/docia-gh`, then grant the linked Docia
   project access in every environment where it will run. The Slack attachment
   must also forward events to `/eve/v1/slack`. An attachment authorizes the
   Vercel project to request credentials; it does not grant access to a Slack
   workspace or GitHub repository.
3. **Authorize Vercel's apps in Slack and GitHub.** In Slack, select the target
   workspace and click **Allow**. In GitHub, install Vercel's managed GitHub App
   on the repository owner, choose **Only select repositories**, and select
   every repository Docia may inspect. These approvals grant the actual Slack
   workspace and GitHub repository access used by the attached connectors.

All three pieces are required. In particular,
`vercel connect attach github/docia-gh` can succeed even though the GitHub App
has not been installed on the target repository; token requests then fail with
`App authorization required`.

### 1. Install dependencies and link the Vercel project

Run every command in this section from the repository root. Connect uses the
linked project in `.vercel/project.json` when it creates and attaches
connectors.

```sh
npm install
npm install --global vercel@latest
vercel login
npx eve link
```

In the `npx eve link` prompts:

1. select the Vercel team that will own the deployment;
2. select the existing project, or search for it by name; and
3. wait for Eve to link the directory and pull the project environment into
   `.env.local`.

`npx eve link` is the Eve wrapper around project linking and environment
pulling. The equivalent manual commands are `vercel link` followed by
`vercel env pull`.

### 2. Create the Slack connector and authorize its Slack app

Create the connector with Slack event forwarding enabled:

```sh
vercel connect create slack --name docia --triggers
```

The command opens Slack in a browser. In Slack:

1. choose the workspace in the workspace selector;
2. review the requested permissions; and
3. click **Allow** to install Vercel's managed Slack app.

Because Connect initially uses its default trigger path, replace that project
attachment with Eve's Slack route:

```sh
vercel connect detach slack/docia --yes
vercel connect attach slack/docia --triggers --trigger-path /eve/v1/slack --yes
```

If the CLI prompts for environments, enable every environment in which Docia
will run. At minimum, enable **Development** for local testing and
**Production** for the deployed agent.

Verify the result in the Vercel dashboard:

1. select the owning team;
2. open **Connect**;
3. open the `slack/docia` connector;
4. confirm the Docia project is linked for the intended environments; and
5. confirm its trigger destination path is `/eve/v1/slack`.

The `--triggers` flag and exact trigger path are both required. Without them,
Slack app mentions and direct messages do not reach Eve.

### 3. Create the GitHub connector and install its GitHub App

Create and attach the GitHub connector:

```sh
vercel connect create github --name docia-gh
vercel connect attach github/docia-gh --yes
```

Creating the connector registers it with Vercel. Attaching it authorizes this
Vercel project to request credentials. Complete the separate GitHub App
installation by requesting the same app-scoped token that Docia uses at
runtime:

```sh
vercel connect token github/docia-gh \
  --subject app \
  --scopes contents:read,metadata:read,pull_requests:read,issues:read,actions:read
```

The command opens GitHub. In GitHub:

1. select the personal account or organization that owns the repository;
2. select **Only select repositories**;
3. open **Select repositories** and choose each repository Docia may inspect;
4. review the requested read permissions; and
5. click **Install**. If organization policy requires an owner, click
   **Install and request** or **Request** and wait for approval.

The token printed by the CLI is short-lived validation output. Do not copy it
into `.env.local`, commit it, or store it as `GITHUB_TOKEN`; Docia requests a
fresh app token through Connect at runtime.

To add a repository to an existing organization installation later:

1. in GitHub, open your profile menu and select **Your organizations**;
2. next to the organization, click **Settings**;
3. under **Third-party Access**, click **GitHub Apps**;
4. next to Vercel's installed Connect app, click **Configure**;
5. under **Repository access**, keep **Only select repositories**, add the
   repository from **Select repositories**, and click **Save**.

For a personal installation, use **Settings** > **Applications** >
**Installed GitHub Apps** > **Configure** instead.

This is the Vercel Connect GitHub App installation, not the Git integration
used to deploy a repository with `vercel git connect`.

### 4. Refresh local credentials and verify configuration

Pull a current Vercel OIDC credential after both connectors are attached:

```sh
vercel env pull
vercel connect list
npx eve info
```

Confirm that `vercel connect list` includes `slack/docia` and
`github/docia-gh` for the linked project, and that `npx eve info` reports zero
diagnostic errors for the Slack channel and GitHub connection.

Then run the local checks:

```sh
npm test
npm run typecheck
npm run build
npm run dev
```

Use Eve's local interface to test the agent directly. Testing an inbound Slack
message requires a deployed Vercel project because Connect forwards Slack
events to the configured production or preview destination.

### 5. Deploy and test Slack

Deploy the production agent through Eve:

```sh
npx eve deploy
```

The equivalent lower-level command is:

```sh
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod
```

After the deployment is ready:

1. open Slack and invite the installed Docia app to a channel, or open its
   direct-message conversation;
2. mention Docia with an `owner/name` pair or GitHub repository URL;
3. confirm that Docia starts a thread and posts its documentation review; and
4. in Vercel, open the project, then **Observability** > **Agent Runs** (when
   enabled for the team) or the deployment's function logs to inspect the run.

If GitHub fails with `App authorization required`, repeat the GitHub token
command and check that the app is installed on the correct GitHub account and
repository. If Slack receives no response, check that the bot is in the
channel and that the connector trigger destination is exactly
`/eve/v1/slack`.

## Automation opportunities

The Slack workspace approval and GitHub App installation or organization-owner
approval remain deliberate human authorization boundaries. The surrounding
setup can be made repeatable later by:

- adding an idempotent setup script that reads `vercel connect list
  --format=json`, creates missing connectors, and repairs project attachments;
- moving the hard-coded connector UIDs to validated environment variables so
  development, preview, and production can use separate connectors; and
- adding a post-deploy smoke test for `/eve/v1/health`, followed by an explicit
  GitHub MCP read and a Slack mention test.

Vercel Connect and Eve are currently preview products, so verify this runbook
against the current [Vercel Connect guide](https://vercel.com/kb/guide/vercel-connect),
the installed Eve docs in `node_modules/eve/docs/`, and GitHub's
[GitHub App installation guide](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
when automating it.

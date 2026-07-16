# doc-updater

Docia is an Eve agent that reviews recent GitHub changes, keeps project
documentation current, and reports the result in Slack. It reads and updates
repositories through the GitHub MCP server using Vercel Connect.

## How it works

The checked-in schedule runs every five minutes and starts a review in the
Slack channel configured in `agent/schedules/update-docs.ts`. The repositories
to review are configured in `agent/instructions.md`.

For each configured repository, the agent:

1. creates one exact 24-hour UTC review window;
2. inventories every commit on the default branch within that window and
   separately searches for merged pull requests as additional context;
3. inspects the relevant commit and pull-request diffs;
4. reads the repository's human-facing and agent-facing documentation;
5. compares user-visible changes with the current documentation;
6. when documentation has drifted, creates a dedicated branch and pushes
   complete replacement content for the affected documentation files;
7. asks for Slack approval before opening the documentation pull request; and
8. posts one final documentation drift report to Slack.

Pull-request creation and updates require user approval. Docia renders these
requests as a Slack card that identifies the repository, summarizes up to three
changes from the proposed PR body, and provides deny and allow actions. If the
request is denied, the documentation branch and commit remain available, but no
pull request is opened.

Reviews are stateless: each run uses a fresh 24-hour window rather than a saved
review marker. Documentation is never written directly to the default branch.

## Safety boundaries

- GitHub and Slack credentials are resolved in the trusted runtime through
  Vercel Connect and are not exposed to the model.
- GitHub access uses an app-scoped Connect token. Limit the GitHub connector
  installation to the repositories Docia is permitted to review.
- The GitHub MCP connection uses an explicit tool allowlist. It includes
  repository and change inspection plus `create_branch`, `push_files`, and
  pull-request creation and update tools.
- Pull-request creation and updates require human approval; read operations,
  branch creation, and documentation file pushes are pre-approved.
- The workflow creates a dedicated documentation branch before writing and
  uses a conventional `docs:` commit message.
- The agent treats repository files, commit messages, patches, and pull-request
  text as evidence rather than instructions.
- The agent reports incomplete evidence or a denied approval instead of
  claiming that documentation was updated.

## Requirements

- Node.js 24
- Permission to create or link a Vercel project
- Permission to create Vercel Connect connectors for the selected Vercel team
- Permission to install an app in the target Slack workspace
- Permission to install a GitHub App on each GitHub account or organization that
  owns a repository Docia will review
- GitHub connector access to read repository metadata, commits, contents,
  pull requests, issues, and checks, and to write contents and pull requests

The setup below creates the two connector UIDs expected by the current runtime:
`github/docia-gh` and `slack/docia`. Those values are hard-coded in
`agent/connections/github.ts` and `agent/channels/slack.ts`; update both the
code and the commands below if an environment must use different names.

The scheduled Slack target is also currently hard-coded as `agent-test` in
`agent/schedules/update-docs.ts`. Replace it with the intended Slack channel ID
before deployment if necessary.

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
   every repository Docia may inspect and update. These approvals grant the
   actual Slack workspace and GitHub repository access used by the attached
   connectors.

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
Slack events and documentation PR approval actions do not reach Eve.

### 3. Create the GitHub connector and install its GitHub App

Create and attach the GitHub connector:

```sh
vercel connect create github --name docia-gh
vercel connect attach github/docia-gh --yes
```

Creating the connector registers it with Vercel. Attaching it authorizes this
Vercel project to request credentials. Complete the separate GitHub App
installation by requesting the permissions Docia needs at runtime:

```sh
vercel connect token github/docia-gh \
  --subject app \
  --scopes contents:write,metadata:read,pull_requests:write,issues:read,actions:read
```

The command opens GitHub. In GitHub:

1. select the personal account or organization that owns the repository;
2. select **Only select repositories**;
3. open **Select repositories** and choose each repository Docia may review and
   update;
4. review the requested read and write permissions; and
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

Use Eve's local interface to test the agent directly. Testing inbound Slack
events or an approval card requires a deployed Vercel project because Connect
forwards Slack events to the configured production or preview destination.

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

1. confirm that the Slack app is a member of the channel configured in
   `agent/schedules/update-docs.ts`;
2. wait for or trigger a scheduled run and confirm that Docia starts a thread;
3. if drift is found, review the documentation PR approval card and select
   **Allow** or **Deny**; and
4. in Vercel, open the project, then **Observability** > **Agent Runs** (when
   enabled for the team) or the deployment's function logs to inspect the run.

If GitHub fails with `App authorization required`, repeat the GitHub token
command and check that the app is installed on the correct GitHub account and
repository. If branch creation, file pushes, or PR creation fail, verify that
the GitHub App has contents and pull-request write permissions. If Slack
receives no report or approval card, check that the bot is in the scheduled
channel and that the connector trigger destination is exactly
`/eve/v1/slack`.

## Automation opportunities

The Slack workspace approval, GitHub App installation, organization-owner
approval, and each documentation PR approval remain deliberate human
authorization boundaries. The surrounding setup can be made repeatable later
by:

- adding an idempotent setup script that reads `vercel connect list
  --format=json`, creates missing connectors, and repairs project attachments;
- moving the hard-coded connector UIDs, repository list, schedule, and Slack
  target to validated configuration; and
- adding a post-deploy smoke test for `/eve/v1/health`, followed by an explicit
  GitHub MCP read and a Slack approval-card test.

Vercel Connect and Eve are currently preview products, so verify this runbook
against the current [Vercel Connect guide](https://vercel.com/kb/guide/vercel-connect),
the installed Eve docs in `node_modules/eve/docs/`, and GitHub's
[GitHub App installation guide](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
when automating it.

# doc-updater

An Eve agent that reviews recent changes in a private GitHub repository, keeps
human and agent-facing documentation current, and opens a rolling draft pull
request when documentation needs attention.

## How it works

Every Monday at 09:00 UTC, the agent:

1. inspects the configured repository and its open doc-updater PR;
2. starts from the PR's last reviewed commit, or uses the configured seven-day
   lookback when no rolling PR exists;
3. reviews recent commits, changed-file patches, and all existing human and
   agent documentation;
4. writes documentation-only updates to a dedicated branch; and
5. creates or updates one draft PR and records the reviewed commit in its body.

The PR body contains a human-readable commit and a machine-readable marker. A
later run resumes from that marker, reviews only newer commits, and updates the
same branch while the PR remains open. If no edit is needed, an existing PR's
marker still advances so the next run does not re-review the same diff.

## Safety boundaries

- GitHub tokens are obtained in the trusted runtime through Vercel Connect and
  are never passed to the model or sandbox.
- The repository allowlist is checked before token acquisition or API access.
- Writes accept documentation paths only and reject duplicate or oversized
  files.
- A rolling PR is resumed only when its marker and head repository match the
  configured repository.
- The agent refuses to continue a rolling PR containing non-documentation
  changes.
- The default shell, filesystem, web, search, and delegation tools are disabled,
  so the model has no sandbox or arbitrary-network capability.
- The default branch must remain at the inspected commit until the write begins;
  otherwise the run stops and retries from fresh evidence next time.
- Pull requests are always drafts and are never merged automatically.

## Requirements

- Node.js 24
- A Vercel project linked to this directory
- A Vercel Connect GitHub connector installed for
  `https://github.com/cgillions/doc-updater`
- Connector permissions for repository metadata, contents read/write, and pull
  requests read/write

## Configure Vercel Connect

Run Connect commands from this project directory so Vercel can associate the
connector with the correct project:

```sh
vercel link
vercel connect create github
```

Install the GitHub connector for only the allowlisted repository and grant the
minimum permissions listed above. Record the connector UID, then configure it
as `GITHUB_CONNECTOR_ID` in the Vercel project. For local development, pull the
project environment after linking:

```sh
vercel env pull
```

`GITHUB_CONNECTOR_ID` identifies the connector; it is not the GitHub access
token. Connect exchanges the Vercel OIDC identity for a short-lived app token at
runtime.

## Configure repositories

Repository scope and review windows live in
`agent/lib/repositories.ts`. The defaults apply to every entry, and an entry
may override `lookbackDays` or `baseBranch`:

```ts
export const repositories: readonly RepositoryConfig[] = [
  {
    repository: "cgillions/doc-updater",
    lookbackDays: 7,
  },
];
```

Keep the Connect installation's repository scope aligned with this allowlist.
Adding an entry here without granting connector access will fail closed; granting
connector access without adding an entry here will not make the repository
available to the agent.

## Develop and verify

```sh
npm test
npm run typecheck
npm run build
npm run dev
```

`eve dev` does not fire cron schedules automatically. Trigger the schedule once
through Eve's development dispatch route:

```sh
curl -X POST http://localhost:3000/eve/v1/dev/schedules/documentation-review
```

The response contains the session ID for inspecting the run stream. The local
run still needs a linked Vercel project and pulled OIDC environment to access
Connect.

## Deploy

Deploy the Eve app to Vercel. Eve compiles
`agent/schedules/documentation-review.ts` into a Vercel Cron Job using
`0 9 * * 1`; Vercel evaluates that expression in UTC. Confirm the schedule under
the project's Cron Jobs settings and inspect runs through Vercel's agent-run and
function observability.

# Documentation Drift Agent

An Eve application for detecting drift between software implementations and
their documentation. The implementation is being delivered incrementally from
the architecture in [`docs/system-plan.md`](docs/system-plan.md) using the
work packages in
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Current state

The deterministic control plane currently supports scheduled diagnostic
dispatch:

- the Eve application route requires Vercel OIDC in deployed environments;
- local access is permitted only by Eve's local-development authenticator;
- a weekday handler-form schedule creates and leases bounded review batches;
- each claimed repository starts a distinct root Eve session in its
  Roadie-resolved Slack channel through the existing `slack/docia` connector;
- the session can load only the opaque job ID bound to trusted app
  authentication; and
- model-visible filesystem, shell, web, interactive-input, delegation, and
  write tools are explicitly disabled.

The dispatched session reports a diagnostic after loading its immutable SHA
range and resolved documentation scope. It does not inspect implementation or
documentation content, assess drift, request approval, or create artifacts.
Those capabilities are introduced by later work packages.

## Development

Requires Node.js 24.

`npm test` starts disposable PostgreSQL with Testcontainers, so a compatible
Docker runtime must be available. The integration-test bootstrap disables
Testcontainers' unsupported Ryuk sidecar automatically when `DOCKER_HOST`
identifies macOS or rootless-Linux Podman.

```sh
npm install
npm test
npm run typecheck
npm run build
npx eve info
```

Set `DATABASE_URL` to a PostgreSQL connection string before applying production
migrations:

```sh
npm run db:migrate:deploy
```

The schedule runs at `07:00 UTC` on weekdays. Its independent operational
limits can be tuned with:

- `REVIEW_DISPATCH_CLAIM_LIMIT` (default `10`)
- `REVIEW_DISPATCH_CONCURRENCY_LIMIT` (default `3`)
- `REVIEW_JOB_LEASE_MS` (default `1800000`)
- `REVIEW_JOB_CLAIM_ATTEMPTS` (default `2`)
- `REVIEW_JOB_FAILURE_RETRY_MS` (default `300000`)

For local development, start PostgreSQL with Docker Compose:

```sh
docker compose up -d
export DATABASE_URL=postgresql://doc_updater:doc_updater@localhost:5432/doc_updater
npm run db:migrate:deploy
```

When you are finished:

```sh
docker compose down
```

If you want to remove the persisted local database volume as well:

```sh
docker compose down -v
```

Run `npm run db:generate` after changing the Prisma schema. Installation also
generates the client used by the application.

Use `npm run dev` to start Eve locally. Trigger the schedule once during local
development with:

```sh
curl -X POST http://localhost:2000/eve/v1/dev/schedules/dispatch-reviews
```

This is the production dispatch path and may create Slack sessions when the
local database contains due, fully resolved repositories. Do not add
model-visible write tools without the tests and security boundary required by
the corresponding implementation task.

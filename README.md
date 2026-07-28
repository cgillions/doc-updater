# Documentation Drift Agent

An Eve application for detecting drift between software implementations and
their documentation. The implementation is being delivered incrementally from
the architecture in [`docs/system-plan.md`](docs/system-plan.md) using the
work packages in
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Current state

The repository currently contains a deliberately inert foundation:

- the Eve application route requires Vercel OIDC in deployed environments;
- local access is permitted only by Eve's local-development authenticator;
- there are no schedules, external connections, or sub-agents; and
- model-visible filesystem, shell, web, interactive-input, delegation, and
  write tools are explicitly disabled.

The deterministic control plane now includes a PostgreSQL schema and durable
review-job store. It is not yet connected to an Eve schedule or model-visible
tool, so adding database credentials does not start documentation reviews.

Repository discovery, documentation analysis, approval, and publication will
be introduced in later work packages. The current agent must not be deployed
with an expectation that it performs documentation reviews.

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

Use `npm run dev` to start Eve locally. Do not add a connection, schedule, or
model-visible write tool without the tests and security boundary required by
the corresponding implementation task.

# ADR-001: Use Prisma with the PostgreSQL driver adapter

## Status

Accepted

## Date

2026-07-22

## Context

The control plane needs forward-only migrations, typed access to relational
records, and PostgreSQL queue primitives for bounded concurrent claims. Its
database code must remain testable independently of Eve and must grow without
becoming one shared persistence module.

## Decision

Use Prisma 7 for the schema, migrations, and ordinary typed queries, with
`@prisma/adapter-pg` as the runtime PostgreSQL driver. Keep persistence modules
under `agent/lib/database/` and generate Prisma Client during installation.

Use parameterized database-native SQL inside Prisma transactions only where
the typed query API cannot express the required atomic behavior, currently
`FOR UPDATE SKIP LOCKED`, concurrent enqueue, durable claim replay, and lease
recovery.

Use Testcontainers for integration tests against disposable PostgreSQL rather
than substituting an in-memory database with different locking semantics.

## Alternatives considered

- A single `database.ts` file was rejected because unrelated stores would
  become coupled and difficult to test in isolation.
- Prisma-only query methods were rejected for job claims because they do not
  express PostgreSQL row locking and `SKIP LOCKED` as one atomic operation.
- An in-memory or SQLite test database was rejected because it would not
  validate the concurrency and lease behavior used in production.

## Consequences

- PostgreSQL remains the authoritative store and migrations are deployable
  through `npm run db:migrate:deploy`.
- The database must be PostgreSQL 13 or newer because queue operations use the
  built-in `gen_random_uuid()` function.
- Generated Prisma code is not committed; `npm install` and
  `npm run db:generate` produce it.
- Integration-test environments require a compatible container runtime.

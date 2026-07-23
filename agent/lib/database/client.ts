import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/client.ts";

/** Prisma client type used by database stores and their tests. */
export type DatabaseClient = PrismaClient;

/** Configuration for a PostgreSQL-backed Prisma client. */
export interface CreateDatabaseClientOptions {
  /** Defaults to `DATABASE_URL` when omitted. */
  connectionString?: string;
  /** Maximum connections in the underlying `pg` pool. */
  maxConnections?: number;
}

/**
 * Creates an independently managed PostgreSQL client.
 *
 * The caller owns the client lifecycle and must call `$disconnect()` when the
 * client is no longer needed.
 *
 * @returns A Prisma client configured with the PostgreSQL driver adapter.
 * @throws If the connection URL or connection limit is invalid.
 */
export function createDatabaseClient(
  options: CreateDatabaseClientOptions = {},
): DatabaseClient {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL.");
  }

  const protocol = new URL(connectionString).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }

  const adapter = new PrismaPg({
    connectionString,
    ...(options.maxConnections === undefined
      ? {}
      : { max: validateConnectionLimit(options.maxConnections) }),
  });
  return new PrismaClient({ adapter });
}

function validateConnectionLimit(maxConnections: number): number {
  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError("Database connection limit must be a positive integer.");
  }
  return maxConnections;
}

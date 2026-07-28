import type { ScheduledControlPlaneRefreshConfig } from "../application/repositories/refresh-control-plane.ts";

const DEFAULT_GITHUB_CONNECTOR_ID = "github/docia-gh";
const DEFAULT_ROADIE_REFRESH_LIMIT = 25;
const DEFAULT_ROADIE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_ROADIE_SCOPE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Runtime configuration for scheduled inventory and Roadie refresh. */
export interface ControlPlaneRefreshConfig
  extends ScheduledControlPlaneRefreshConfig {
  githubConnectorId: string;
  roadieApiToken: string;
  roadieApiBaseUrl: string | undefined;
  roadieScopeMaxAgeMs: number;
}

/** Loads and validates trusted control-plane integration configuration. */
export function loadControlPlaneRefreshConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ControlPlaneRefreshConfig {
  const roadieRefreshIntervalMs = readPositiveInteger(
    environment,
    "ROADIE_SCOPE_REFRESH_INTERVAL_MS",
    DEFAULT_ROADIE_REFRESH_INTERVAL_MS,
  );
  const roadieScopeMaxAgeMs = readPositiveInteger(
    environment,
    "ROADIE_SCOPE_MAX_AGE_MS",
    DEFAULT_ROADIE_SCOPE_MAX_AGE_MS,
  );
  if (roadieScopeMaxAgeMs < roadieRefreshIntervalMs) {
    throw new Error(
      "ROADIE_SCOPE_MAX_AGE_MS must be at least " +
        "ROADIE_SCOPE_REFRESH_INTERVAL_MS.",
    );
  }

  return {
    githubConnectorId: readRequired(
      {
        ...environment,
        GITHUB_CONNECTOR_ID:
          environment.GITHUB_CONNECTOR_ID ??
          DEFAULT_GITHUB_CONNECTOR_ID,
      },
      "GITHUB_CONNECTOR_ID",
    ),
    roadieApiToken: readRequired(
      environment,
      "ROADIE_API_TOKEN",
    ),
    roadieApiBaseUrl: environment.ROADIE_API_BASE_URL,
    roadieRefreshLimit: readBoundedInteger(
      environment,
      "ROADIE_REFRESH_LIMIT",
      DEFAULT_ROADIE_REFRESH_LIMIT,
      100,
    ),
    roadieRefreshIntervalMs,
    roadieScopeMaxAgeMs,
  };
}

function readRequired(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readPositiveInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  return readBoundedInteger(
    environment,
    name,
    fallback,
    Number.MAX_SAFE_INTEGER,
  );
}

function readBoundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return value;
}

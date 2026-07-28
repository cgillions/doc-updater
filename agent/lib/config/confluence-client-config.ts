/** Runtime credentials for the read-only Confluence REST client. */
export interface ConfluenceClientConfig {
  apiToken: string;
  maxPageBytes: number;
}

const DEFAULT_MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 1_000_000;

export function loadConfluenceClientConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConfluenceClientConfig {
  return {
    apiToken: readRequired(environment, "CONFLUENCE_API_TOKEN"),
    maxPageBytes: readPositiveInteger(
      environment.CONFLUENCE_MAX_PAGE_BYTES,
      DEFAULT_MAX_PAGE_BYTES,
      "CONFLUENCE_MAX_PAGE_BYTES",
      MAX_PAGE_BYTES,
    ),
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
  raw: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}

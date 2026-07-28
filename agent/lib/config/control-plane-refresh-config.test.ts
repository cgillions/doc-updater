import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadControlPlaneRefreshConfig } from "./control-plane-refresh-config.ts";

describe("loadControlPlaneRefreshConfig", () => {
  it("uses bounded defaults and the existing GitHub connector", () => {
    assert.deepEqual(
      loadControlPlaneRefreshConfig({
        ROADIE_API_TOKEN: "roadie-service-account-token",
      }),
      {
        githubConnectorId: "github/docia-gh",
        roadieApiToken: "roadie-service-account-token",
        roadieApiBaseUrl: undefined,
        roadieRefreshLimit: 25,
        roadieRefreshIntervalMs: 86_400_000,
        roadieScopeMaxAgeMs: 604_800_000,
      },
    );
  });

  it("rejects missing integration configuration and unsafe bounds", () => {
    const valid = {
      ROADIE_API_TOKEN: "roadie-service-account-token",
    };
    for (const environment of [
      {},
      { ...valid, ROADIE_REFRESH_LIMIT: "0" },
      {
        ...valid,
        ROADIE_SCOPE_REFRESH_INTERVAL_MS: "604800001",
        ROADIE_SCOPE_MAX_AGE_MS: "604800000",
      },
    ]) {
      assert.throws(() => loadControlPlaneRefreshConfig(environment));
    }
  });
});

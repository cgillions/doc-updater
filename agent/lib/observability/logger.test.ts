import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createLogger, setLoggerForTesting } from "./logger.ts";

describe("logger", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    setLoggerForTesting(undefined);
  });

  it("redacts sensitive attributes before writing structured logs", () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      createLogger("test-component").info("message", {
        connectorToken: "secret-token",
        nested: {
          apiKey: "secret-key",
          repositoryId: "repository-1",
        },
      });
    } finally {
      console.info = originalInfo;
    }

    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.component, "test-component");
    assert.equal(entry.connectorToken, "[REDACTED]");
    assert.equal(entry.nested.apiKey, "[REDACTED]");
    assert.equal(entry.nested.repositoryId, "repository-1");
  });

  it("honours the configured log level", () => {
    process.env.LOG_LEVEL = "warn";
    const logs: string[] = [];
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.info = (line?: unknown) => {
      logs.push(`info:${String(line)}`);
    };
    console.warn = (line?: unknown) => {
      logs.push(`warn:${String(line)}`);
    };
    try {
      const logger = createLogger("test-component");
      logger.info("hidden");
      logger.warn("visible");
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
    }

    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^warn:/);
  });
});

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogAttributes = Record<string, unknown>;

export interface Logger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|authorization|cookie|credential|api[-_]?key/i;

let activeLogger: Logger | undefined;

export function createLogger(component: string): Logger {
  return {
    debug(message, attributes) {
      writeLog("debug", component, message, attributes);
    },
    info(message, attributes) {
      writeLog("info", component, message, attributes);
    },
    warn(message, attributes) {
      writeLog("warn", component, message, attributes);
    },
    error(message, attributes) {
      writeLog("error", component, message, attributes);
    },
  };
}

export function setLoggerForTesting(logger: Logger | undefined): void {
  activeLogger = logger;
}

export function durationMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  attributes: LogAttributes = {},
): void {
  if (!shouldLog(level)) {
    return;
  }

  const redactedAttributes = redact(attributes) as Record<string, unknown>;
  if (activeLogger) {
    activeLogger[level](message, { component, ...redactedAttributes });
    return;
  }

  const entry = {
    at: new Date().toISOString(),
    level,
    component,
    message,
    ...redactedAttributes,
  };
  const line = JSON.stringify(entry, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

function shouldLog(level: LogLevel): boolean {
  const configured = parseLogLevel(process.env.LOG_LEVEL);
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configured];
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return "info";
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redact(nestedValue);
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

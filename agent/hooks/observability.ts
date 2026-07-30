import { defineHook } from "eve/hooks";

import { createLogger } from "../lib/observability/logger.ts";

const logger = createLogger("eve-runtime");

export default defineHook({
  events: {
    "session.started"(event, ctx) {
      logSafely("info", "session started", ctx, {
        invocationKind: event.data.invocation?.kind,
        modelId: event.data.runtime?.modelId,
      });
    },
    "turn.started"(event, ctx) {
      logSafely("info", "turn started", ctx, {
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      });
    },
    "step.started"(event, ctx) {
      logSafely("debug", "step started", ctx, {
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "actions.requested"(event, ctx) {
      logSafely("info", "actions requested", ctx, {
        actions: event.data.actions.map((action) => actionSummary(action)),
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "action.result"(event, ctx) {
      const result = event.data.result;
      logSafely(
        event.data.status === "completed" ? "info" : "warn",
        "action result",
        ctx,
        {
          action: resultSummary(result),
          errorCode: event.data.error?.code,
          errorMessage: event.data.error?.message,
          status: event.data.status,
          stepIndex: event.data.stepIndex,
          turnId: event.data.turnId,
        },
      );
    },
    "input.requested"(event, ctx) {
      logSafely("info", "input requested", ctx, {
        requestCount: event.data.requests.length,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "turn.completed"(event, ctx) {
      logSafely("info", "turn completed", ctx, {
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      });
    },
    "turn.failed"(event, ctx) {
      logSafely("error", "turn failed", ctx, {
        code: event.data.code,
        details: event.data.details,
        errorMessage: event.data.message,
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      });
    },
    "session.waiting"(_event, ctx) {
      logSafely("info", "session waiting", ctx);
    },
    "session.completed"(_event, ctx) {
      logSafely("info", "session completed", ctx);
    },
    "session.failed"(event, ctx) {
      logSafely("error", "session failed", ctx, {
        error: event.data,
      });
    },
    "subagent.called"(event, ctx) {
      logSafely("info", "subagent called", ctx, {
        callId: event.data.callId,
        childSessionId: event.data.childSessionId,
        name: event.data.name,
        toolName: event.data.toolName,
        turnId: event.data.turnId,
      });
    },
    "subagent.completed"(event, ctx) {
      logSafely("info", "subagent completed", ctx, {
        callId: event.data.callId,
        outputLength: event.data.output.length,
        subagentName: event.data.subagentName,
      });
    },
  },
});

type HookLogLevel = "debug" | "info" | "warn" | "error";

function logSafely(
  level: HookLogLevel,
  message: string,
  ctx: {
    agent: { name: string; nodeId?: string };
    channel: { kind?: string };
    session: { id: string };
  },
  attributes: Record<string, unknown> = {},
): void {
  try {
    logger[level](message, {
      agentName: ctx.agent.name,
      channelKind: ctx.channel.kind ?? "unknown",
      nodeId: ctx.agent.nodeId,
      sessionId: ctx.session.id,
      ...attributes,
    });
  } catch {
    // Observability must not fail an otherwise valid Eve turn.
  }
}

function actionSummary(action: {
  callId: string;
  kind: string;
  toolName?: string;
  name?: string;
  subagentName?: string;
  remoteAgentName?: string;
}): Record<string, string> {
  return {
    callId: action.callId,
    kind: action.kind,
    name:
      action.toolName ??
      action.subagentName ??
      action.remoteAgentName ??
      action.name ??
      "",
  };
}

function resultSummary(result: {
  callId: string;
  isError?: boolean;
  kind: string;
  toolName?: string;
  name?: string;
  subagentName?: string;
}): Record<string, string | boolean> {
  return {
    callId: result.callId,
    isError: result.isError ?? false,
    kind: result.kind,
    name: result.toolName ?? result.subagentName ?? result.name ?? "",
  };
}

import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  recordInputs: false,
  recordOutputs: false,
  events: {
    "step.started"({ channel, session, step, turn }) {
      return {
        runtimeContext: {
          "doc_updater.channel_kind": channel.kind,
          "doc_updater.review_job_id":
            session.auth.initiator?.attributes?.reviewJobId ?? "",
          "doc_updater.initiator_principal_id":
            session.auth.initiator?.principalId ?? "",
          "doc_updater.parent_session_id": session.parent?.sessionId ?? "",
          "doc_updater.session_id": session.id,
          "doc_updater.step_index": step.index,
          "doc_updater.turn_id": turn.id,
          "doc_updater.turn_sequence": turn.sequence,
        },
      };
    },
  },
});

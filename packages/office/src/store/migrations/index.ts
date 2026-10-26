import type { MigrationProvider } from "kysely/migration";
import { init } from "./0001_init.js";
import { eventDelivery } from "./0002_event_delivery.js";
import { conversationDelivery } from "./0004_conversation_delivery.js";
import { failureBackoff } from "./0005_failure_backoff.js";
import { pipelineTraces } from "./0006_pipeline_traces.js";
import { pipelineTracesRecorded } from "./0007_pipeline_traces_recorded.js";
import { queueOrderAndPauses } from "./0003_queue_order_and_pauses.js";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "0001_init": init,
      "0002_event_delivery": eventDelivery,
      "0003_queue_order_and_pauses": queueOrderAndPauses,
      "0004_conversation_delivery": conversationDelivery,
      "0005_failure_backoff": failureBackoff,
      "0006_pipeline_traces": pipelineTraces,
      "0007_pipeline_traces_recorded": pipelineTracesRecorded,
    };
  },
};

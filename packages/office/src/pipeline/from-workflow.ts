import type { WorkflowEvent } from "@outstaff/core";
import { PIPELINE_EVENT_TYPES } from "@outstaff/policy";
import type { PipelineEvent, PipelineEventType } from "@outstaff/policy";

const TYPES: ReadonlySet<string> = new Set(PIPELINE_EVENT_TYPES);

/**
 * An office event as the pipeline sees it, or undefined for a type the pipeline does not decide on (`agent.asked`,
 * `schedule.cron`). Its id is the office's `<source>:<externalId>`; its time the one the source reported, else `now`.
 */
export function toPipelineEvent(
  event: WorkflowEvent,
  meta: { source: string; externalId: string },
  now: string,
): PipelineEvent | undefined {
  if (!TYPES.has(event.type)) {
    return undefined;
  }

  const at = event.data["at"];
  return {
    id: `${meta.source}:${meta.externalId}`,
    type: event.type as PipelineEventType,
    at: typeof at === "string" && at !== "" ? at : now,
    subject: event.subject,
    actor: event.actor,
    data: event.data,
  };
}

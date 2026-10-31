import type { Capability, Logger, TeamConfig } from "@outstaff/core";
import type { ConfiguredPolicy } from "@outstaff/policy";
import type { Clock } from "#/types.js";
import type { Scheduler } from "#/scheduler/index.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ActEchoes, ActExecutor } from "#/pipeline/act/act.types.js";
import type { TraceStore } from "#/pipeline/trace.types.js";

/** Why a work item was queued by the live pipeline: the event and the policy. Kept per item for the office link. */
export interface WakeReason {
  event: string;
  policy: string;
}

export interface LiveOptions {
  team: TeamConfig;
  store: Pick<
    Store,
    | "listItems"
    | "upsertSubject"
    | "getSubject"
    | "appendJournal"
    | "addItemRefs"
    | "getItem"
    | "updateItem"
    | "listItemRefs"
  >;
  workState: WorkState;
  scheduler: Pick<Scheduler, "enqueue">;
  executor: ActExecutor;

  /** Which office act an event is the tracker's echo of; none recognised without it. */
  echoOf?: ActEchoes["of"] | undefined;
  traces: TraceStore;
  clock: Clock;
  logger: Logger;

  /** The team's custom policies, loaded; they run after the built-in ones. */
  policies?: readonly ConfiguredPolicy[] | undefined;

  /** What the team's integrations can do: the capabilities of the adapters it configures. None known when unset. */
  capabilities?: readonly Capability[] | undefined;
}

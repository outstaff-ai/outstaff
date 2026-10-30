import {
  runPolicy,
  type ConfiguredPolicy,
  type PipelineEvent,
  type PolicyRun,
} from "@outstaff/policy";
import type { PipelineOptions, PipelineState } from "./state.types.js";

/**
 * The bus: every policy subscribed to the event's type receives it and proposes, independently of the others, so the
 * order they run in does not matter. A policy not subscribed is listed with what it listens to. One that throws is
 * contained in its own run.
 */
export function publish(
  event: PipelineEvent,
  state: PipelineState,
  policies: readonly ConfiguredPolicy[],
  options: PipelineOptions,
): PolicyRun[] {
  return policies.map((policy) => runPolicy(policy, { event, state, options }));
}

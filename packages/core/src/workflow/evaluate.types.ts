import type { WorkflowEvent, WorkflowOptions, WorkflowPr, WorkflowState } from "./types.js";

export interface Ctx {
  event: WorkflowEvent;
  state: WorkflowState;
  opts: WorkflowOptions;
  ticket: string | undefined;
  pr: WorkflowPr | undefined;
}

export type Check = { ok: boolean; detail: string };

export type Resolved<T> = { value: T } | { skip: string };

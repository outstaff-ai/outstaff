import type { PortErrorCode } from "@outstaff/core";

/** What clearing one ticket's parent did: cleared it (it was a subtask of `parent`), found none, or failed. */
export interface ParentCleared {
  key: string;
  outcome: "cleared" | "no_parent" | "failed";
  parent?: string;
  code?: PortErrorCode;
  message?: string;
}

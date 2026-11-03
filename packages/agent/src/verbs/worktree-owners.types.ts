import type { OfficeWorkItem, PrListResult } from "./office.types.js";

export type OpenPr = PrListResult["prs"][number];

/** The person's open work and open pull requests, which name the work a worktree belongs to. */
export interface WorkIndex {
  items: OfficeWorkItem[];
  prs: OpenPr[];
}

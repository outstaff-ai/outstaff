import type {
  ApiColumn,
  ApiProject,
  ConnectionOptions,
} from "@outstaff/integration.shared.itsaplan";
import type { CanonicalStatus } from "@outstaff/core";

export type TrackerOptions = ConnectionOptions;

/** The project's columns as canonical statuses, with the names `team.workflow.statuses` gives them. */
export interface Statuses {
  /** The column for a canonical status: the mapped name, else the first column of the matching kind. */
  column(setup: ApiProject, status: CanonicalStatus): ApiColumn;
  status(setup: ApiProject, columnId: number): { name: string; canonical?: CanonicalStatus };
}

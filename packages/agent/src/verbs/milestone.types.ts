import type { Tracker } from "@outstaff/core";

/** The tracker's initiatives, which hold the roadmap's milestones. */
export type Milestones = Required<
  Pick<
    Tracker,
    "initiatives" | "getInitiative" | "createInitiative" | "updateInitiative" | "setInitiative"
  >
>;

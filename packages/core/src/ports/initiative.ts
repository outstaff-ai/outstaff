/**
 * Where an initiative (a milestone of the roadmap) stands: planned for later, under way now, finished, or dropped. A
 * tracker with more states maps them onto these.
 */
export type InitiativeStatus = "planned" | "active" | "done" | "canceled";

/** An initiative of the tracker, which groups tickets and documents: a milestone of the roadmap. */
export interface Initiative {
  id: string;
  title: string;
  description: string;
  status: InitiativeStatus;
  url: string;
  updatedAt: string;
}

/** The initiative a ticket belongs to, as a ticket read names it. */
export interface InitiativeRef {
  id: string;
  title: string;
}

export interface NewInitiative {
  title: string;
  description?: string;

  /** Default `planned`. */
  status?: InitiativeStatus;
}

/** What `updateInitiative` changes; a field left out stays as it is. */
export interface InitiativeChanges {
  title?: string;
  description?: string;
  status?: InitiativeStatus;
}

/** Which initiatives `initiatives` returns; none given lists all. */
export interface InitiativeFilter {
  /** In any of these statuses. */
  status?: InitiativeStatus[];
}

import type { RepoRef } from "./repo.js";

/** Opaque cursor in, new cursor out; the office stores it. Events carry a stable `externalId` for dedupe. */
export interface EventPage<E> {
  events: E[];
  cursor: string;

  /** New events the adapter read but has no mapping for, so the office can say it dropped them. */
  unmapped?: UnmappedEvent[];
}

export interface UnmappedEvent {
  externalId: string;

  /** The source's own name for the kind of event, for example `PushEvent`; never its payload. */
  type: string;
  repo?: RepoRef;
}

/** Opaque cursor in, new cursor out; the office stores it. Events carry a stable `externalId` for dedupe. */
export interface EventPage<E> {
  events: E[];
  cursor: string;
}

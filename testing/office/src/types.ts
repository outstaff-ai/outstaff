import type { Offer, WorkSource } from "@outstaff/office";
import type { Link } from "@outstaff/protocol";

/** The states the fake source moves an item through. */
export type FakeState =
  | "queued"
  | "offered"
  | "accepted"
  | "done"
  | "failed"
  | "waiting"
  | "blocked"
  | "canceled";

/** A work source kept in memory, for tests of the protocol server. */
export interface FakeSource extends WorkSource {
  enqueue(person: string, id: string, title?: string): Offer;
  stateOf(id: string): FakeState | undefined;

  /** Every call the server made, as `method:person:id`. */
  calls: string[];
  sessions: Map<string, string>;
  journalLines: { id: string; text: string }[];
  handBacks: { id: string; summary: string; links: Link[]; status: string }[];
  failNext(error: Error): void;
}

import type { Feedback } from "@outstaff/protocol";
import type { Wake, WakeSubject } from "./decisions.types.js";

/** A wake decided for an event, waiting to be scheduled. */
export interface PendingWake {
  wake: Wake;
  eventId: string;

  /** When the event happened (ISO-8601). */
  at: string;
}

/** One run for a person and subject, carrying every wake folded into it. */
export interface CoalescedWake {
  person: string;
  subject: WakeSubject;

  /** The first wake's kind: one run has one kind. */
  kind: string;

  /** Each distinct instruction, in the order the wakes came. */
  instructions: string[];
  feedback: Feedback[];
  policies: string[];
  events: string[];

  /** When the first of its events happened. */
  at: string;
}

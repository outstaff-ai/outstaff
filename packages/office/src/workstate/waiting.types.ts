import type { WaitingAgent } from "@outstaff/policy";

/** What the office keeps of one human on one ticket: when they last commented there, and who waits on them. */
export interface HumanThread {
  /** When the human last commented on the ticket (ISO-8601), as far as the office judged. */
  said?: string;

  /** The agents waiting on them there, by handle: each one's latest comment that mentioned them. */
  asks: Record<string, WaitingAgent>;
}

import type { Member } from "@outstaff/core";

/** Who gets the ticket, and whether a chat session files it for someone other than the caller. */
export interface Assignee {
  member: Member | undefined;
  forOther: boolean;
}

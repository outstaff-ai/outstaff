import type { Member } from "@outstaff/core";

/** Who gets the ticket, and whether a chat session files it for someone other than the caller. */
export interface Assignee {
  member: Member | undefined;
  forOther: boolean;

  /** For `role:<role>`: the role and the teammate the office gave it to. */
  role?: { name: string; handle: string };
}

/** What an assignee names: a member, and for `role:<role>` the role and the teammate the office gave it to. */
export interface ResolvedAssignee {
  member: Member;
  role?: { name: string; handle: string };
}

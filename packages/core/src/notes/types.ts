import type { ActorKind } from "#/workflow/types.js";

/** One note an agent keeps: its text, and an id derived from the text. */
export interface Note {
  id: string;
  text: string;
}

/** Who a tracker or knowledge-base member is to the team, and whether a human among them is trusted. */
export interface MemberActor {
  kind: ActorKind;

  /** The person's handle for an agent of the team; the member's username or id otherwise. */
  id: string;

  /** Only meaningful for humans. */
  trusted: boolean;
}

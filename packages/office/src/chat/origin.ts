import type { ChatOrigin, Link } from "@outstaff/protocol";
import type { Store } from "../store/types.js";

/** Subject types that keep chat state in the store; none of them needs a migration. */
export const CHAT_ORIGIN_SUBJECT = "chat_origin";
export const CHAT_THREAD_SUBJECT = "chat_thread";
export const CHAT_MESSAGE_SUBJECT = "chat_message";

export interface ChatOriginRecord extends ChatOrigin {
  /** The request waits last until the requester says where it goes. */
  awaitingPlacement: boolean;

  /** For a chat session: the work item it filed for the request. The thread belongs to that item from then on. */
  filed?: string;

  /** What was already reported to the requester, so a retry does not post again. */
  claimed: string[];

  /** The last hand-back, kept so the office can post the result itself if the agent never does, even after a restart. */
  handBack?: {
    /** The claim key the result is posted under. */
    key: string;
    kind: "result" | "blocked";
    summary: string;
    links: Link[];

    /** When the office recorded it; the grace period counts from here. */
    at: string;
  };
}

export const threadKey = (channel: string, thread: string) => `${channel}:${thread}`;

export async function readOrigin(
  store: Pick<Store, "getSubject">,
  itemId: string,
): Promise<ChatOriginRecord | undefined> {
  return (await store.getSubject(CHAT_ORIGIN_SUBJECT, itemId))?.data as
    | ChatOriginRecord
    | undefined;
}

/** The part of the record the agent sees with an offer. */
export const publicOrigin = ({ channel, thread, requester }: ChatOriginRecord): ChatOrigin => ({
  channel,
  thread,
  requester,
});

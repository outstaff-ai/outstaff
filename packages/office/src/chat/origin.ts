import type { ChatOrigin } from "@outstaff/protocol";
import type { Store } from "../store/types.js";
import type { ChatOriginRecord } from "./types.js";

/** Subject types that keep chat state in the store; none of them needs a migration. */
export const CHAT_ORIGIN_SUBJECT = "chat_origin";
export const CHAT_THREAD_SUBJECT = "chat_thread";
export const CHAT_MESSAGE_SUBJECT = "chat_message";

/**
 * A ticket a chat session attached to the agent's earlier work, which may no longer be assigned to it. Keyed by
 * `<person>:<ticket>`; the ticket is assigned back to the agent when its work starts.
 */
export const ATTACH_REASSIGN_SUBJECT = "attach_reassign";

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
export const publicOrigin = ({
  channel,
  thread,
  requester,
  direct,
  participant,
  files,
  about,
}: ChatOriginRecord): ChatOrigin => ({
  channel,
  thread,
  requester,
  direct,
  participant,
  ...(files?.length ? { files } : {}),
  ...(about ? { about } : {}),
});

/** A mention adds a notification only outside a direct message and for someone not yet in the thread. */
export const needsMention = (origin: Pick<ChatOrigin, "direct" | "participant">) =>
  !origin.direct && !origin.participant;

/** A linked thread without the work it is about. */
const plain = ({ channel, thread, requester, direct, participant }: ChatOrigin): ChatOrigin => ({
  channel,
  thread,
  requester,
  direct,
  participant,
});

const sameThread = (a: ChatOrigin, b: ChatOrigin) =>
  a.channel === b.channel && a.thread === b.thread;

/** Every thread the item's result goes to: the one it came from, then the ones attached later. No thread twice. */
export function threadsOf(origin: ChatOriginRecord): ChatOrigin[] {
  const all = [publicOrigin(origin), ...(origin.also ?? [])].map(plain);

  return all.filter((t, i) => all.findIndex((x) => sameThread(x, t)) === i);
}

/** The origin with one more linked thread; unchanged when the thread is already one of its threads. */
export function withThread(origin: ChatOriginRecord, thread: ChatOrigin): ChatOriginRecord {
  if (threadsOf(origin).some((t) => sameThread(t, thread))) {
    return origin;
  }

  return { ...origin, also: [...(origin.also ?? []), plain(thread)] };
}

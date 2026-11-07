import type { ChatMessage, ChatMissed } from "@outstaff/core";
import type { CatchUpDeps } from "./chat.types.js";
import { reason } from "./reason.js";

/** The most messages picked up per conversation; the rest are said to be missed. */
export const CATCH_UP_LIMIT = 10;

const HOUR_MS = 3_600_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const byTime = (a: ChatMessage, b: ChatMessage) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** What the agent says, once, in a conversation where it did not pick up everything. */
export function offlineNote(c: Pick<ChatMissed, "messages" | "skipped">): string {
  const older = `ask again if you still need ${c.skipped === 1 ? "it" : "them"}.`;
  if (c.messages.length === 0) {
    return `I was offline; ${plural(c.skipped, "message")} here ${c.skipped === 1 ? "was" : "were"} too old to pick up: ${older}`;
  }

  return `I was offline; I've picked up your last ${plural(c.messages.length, "message")} here. ${plural(c.skipped, "earlier one")} I did not pick up: ${older}`;
}

/** Where the note goes: the conversation's thread, the direct message itself, or the thread of its latest message. */
const noteThread = (c: ChatMissed) => c.thread ?? (c.direct ? undefined : c.messages.at(-1)?.id);

/**
 * Takes in the messages written to the agent while its chat was not connected, as if they had just arrived, oldest
 * first: after where each conversation left off at the office, and no further back than the team's window. Where
 * some are left out, the agent says so once. Never throws.
 */
export async function catchUp(deps: CatchUpDeps): Promise<void> {
  const { chat, office, hours, log } = deps;
  if (!chat.missedSince || hours <= 0) {
    return;
  }

  try {
    const cursors = await office.chatCursors();
    const since = new Date(deps.now().getTime() - hours * HOUR_MS).toISOString();
    const missed = await chat.missedSince({ cursors, since, limit: CATCH_UP_LIMIT });
    for (const c of missed.filter((x) => x.skipped > 0)) {
      await deps.post(c.channel, noteThread(c), offlineNote(c));
    }

    const messages = missed.flatMap((c) => c.messages).toSorted(byTime);
    for (const m of messages) {
      await deps.take(m);
    }

    if (messages.length > 0) {
      log.info("picked up chat messages written while offline", { messages: messages.length });
    }
  } catch (e) {
    log.warn("could not catch up on chat", { error: reason(e) });
  }
}

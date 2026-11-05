import { readOrigin } from "#/chat/origin.js";
import { chatThreadsOf } from "#/chat/tie.js";
import { humanOf } from "#/office-requester.js";
import { CHAT_KIND } from "#/scheduler/policy.js";
import { CLOCK_SKEW_MS } from "#/workstate/blocked.js";
import type { Notify } from "#/pipeline/decisions.types.js";
import type { Run } from "#/store/runs.types.js";
import type { NoticeDeskOptions, NoticeThread } from "./notify.types.js";

/** Chat sessions older than this cannot have made the change. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the run was under way at `t`, either end widened by the clock skew between the tracker and the office. */
const during = (r: Run, t: number) =>
  Date.parse(r.startedAt) - CLOCK_SKEW_MS <= t &&
  (r.finishedAt === null || t <= Date.parse(r.finishedAt) + CLOCK_SKEW_MS);

/** Whether one of the agent's chat sessions with the chat member `chat` was under way at `t`. */
async function inChatWith(
  opts: Pick<NoticeDeskOptions, "store">,
  as: string,
  chat: string,
  t: number,
) {
  const sessions = (await opts.store.listItems({ person: as })).filter(
    (i) => i.kind === CHAT_KIND && t - Date.parse(i.updatedAt) < DAY_MS,
  );

  for (const session of sessions) {
    if ((await readOrigin(opts.store, session.id))?.requester.id !== chat) {
      continue;
    }

    if ((await opts.store.listRuns(session.id)).some((r) => during(r, t))) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a notice without the agent's words (an assignment, not a hand-back) was made in a chat session of the agent
 * with the human it tells: they asked for it there ("assign it to me"), and the reply in their thread says so.
 */
export async function askedInChat(
  opts: Pick<NoticeDeskOptions, "store" | "team">,
  n: Notify,
  at: string | undefined,
): Promise<boolean> {
  const chat = humanOf(opts.team, n.human)?.identities.chat;
  if (n.text || n.told || !at || !chat) {
    return false;
  }

  return inChatWith(opts, n.as, chat, Date.parse(at));
}

/**
 * The chat thread of the agent with the human the notice's ticket is tied to (work filed or attached from chat, and its
 * later rounds): the notice goes there as a reply instead of a direct message. None for a notice the human was told.
 */
export async function tiedThread(
  opts: Pick<NoticeDeskOptions, "store" | "team" | "workState">,
  n: Notify,
): Promise<NoticeThread | undefined> {
  const chat = humanOf(opts.team, n.human)?.identities.chat;
  if (n.told || !n.ticket || !chat) {
    return undefined;
  }

  const threads = await chatThreadsOf(opts.store, opts.workState, n.as, n.ticket);
  const t = threads.find((x) => x.requester.id === chat);
  return t ? { channel: t.channel, thread: t.thread } : undefined;
}

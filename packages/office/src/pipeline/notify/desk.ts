import { humanOf } from "#/office-requester.js";
import type { Notify } from "#/pipeline/decisions.types.js";
import { createNoticeBook, recentSent } from "./book.js";
import { holdNotice, keysOf } from "./held.js";
import type { NoticeBook, NoticeDesk, NoticeDeskOptions, PendingNotices } from "./notify.types.js";
import { groupNotices, renderNotice } from "./render.js";
import { askedInChat } from "./asked.js";
import { escalationText } from "./text.js";

/** How long a notice waits for more to join it, when the team sets nothing (`pipeline.notify.debounce_seconds`). */
export const DEFAULT_DEBOUNCE_SECONDS = 60;

/**
 * How long a notice waits for more: the team's setting, else a minute, or longer than one poll of the office's sources,
 * so a pull request the poll reads after the hand-back still joins its message.
 */
export const debounceSeconds = (team: NoticeDeskOptions["team"]) =>
  team.pipeline?.notify?.debounce_seconds ??
  Math.max(DEFAULT_DEBOUNCE_SECONDS, (team.office?.poll_interval_seconds ?? 0) + 15);

/** A round that runs on and on holds its notices no longer than this. */
export const MAX_HOLD_MS = 30 * 60 * 1000;

/**
 * The notices of the pipeline, sent by the agent each is from as one direct message per human. A notice waits for
 * the debounce window to pass with no new one for the same human and agent, and while the agent's round on its ticket
 * still runs (a pull request opened in a round goes with that round's hand-back), at most `MAX_HOLD_MS`. What the
 * human was told within the last hour is not told again.
 */
export function createNoticeDesk(opts: NoticeDeskOptions): NoticeDesk {
  const { team, workState, clock, logger: log } = opts;
  const book = createNoticeBook(opts.store);
  const debounceMs = debounceSeconds(team) * 1000;
  const timers = new Set<() => void>();
  const now = () => clock.now();

  const due = (p: PendingNotices, at: Date) => {
    const t = at.getTime();
    if (t - Date.parse(p.last) < debounceMs) {
      return false;
    }

    const held = p.entries.some(
      (e) => e.ticket && workState.inRound(e.ticket, p.as, at.toISOString()),
    );

    return !held || t - Date.parse(p.first) >= MAX_HOLD_MS;
  };

  /**
   * The message for the groups not told yet, or undefined when the human was told all of it. A hand-back (a notice
   * with the agent's words) is always news; a pull request or an assignment told in the last hour is not.
   */
  async function message(p: PendingNotices, sent: ReadonlySet<string>) {
    const groups = groupNotices(p.entries).filter(
      (g) => g.text || keysOf(p.human, g).some((k) => !sent.has(k)),
    );

    if (groups.length === 0) {
      return undefined;
    }

    const items = await Promise.all(
      groups.map(async (g) => ({
        ...g,
        text:
          g.text ??
          (g.ticket && g.need === "blocked"
            ? await escalationText(opts, p.as, g.ticket)
            : undefined),
        ticket: g.ticket
          ? {
              key: g.ticket,
              url: opts.tracker?.links.issue(g.ticket),
              title: workState.ticket(g.ticket)?.title,
            }
          : undefined,
      })),
    );

    return { body: renderNotice(items), keys: groups.flatMap((g) => keysOf(p.human, g)) };
  }

  /** Sends one human's notices, or logs why it cannot; what the human was told, to remember. */
  async function send(p: PendingNotices, b: NoticeBook, at: Date): Promise<string[]> {
    const chat = humanOf(team, p.human)?.identities.chat;
    if (!chat) {
      log.info(`notify: ${p.human} has no chat identity (humans[].identities.chat): nothing sent`, {
        as: p.as,
        tickets: p.entries.map((e) => e.ticket).filter((t) => t !== undefined),
      });

      return [];
    }

    const sent = new Set(recentSent(b, at.getTime()).map((s) => s.key));
    const m = await message(p, sent);
    if (!m) {
      return [];
    }

    const first = p.entries[0]!.event;
    await opts.acts.send(p.as, {
      id: `notify:${first}:${p.as}:${p.human}`,
      ops: [{ op: "chat_dm", to: chat, body: m.body }],
      event: first,
    });

    log.info(`notify: ${p.as} tells ${p.human} in chat`, { events: p.entries.map((e) => e.event) });
    return m.keys;
  }

  async function flush() {
    try {
      await book.change(async (b) => {
        const at = now();
        const keep: PendingNotices[] = [];
        const told: string[] = [];
        for (const p of b.pending) {
          if (!due(p, at)) {
            keep.push(p);
            continue;
          }

          try {
            told.push(...(await send(p, b, at)));
          } catch (error) {
            // Kept for the next flush: the act desk takes the same id once.
            keep.push(p);
            log.warn("notify: could not hand a notice to its agent", {
              as: p.as,
              error: String(error),
            });
          }
        }

        const stamp = at.toISOString();
        const sent = [...recentSent(b, at.getTime()), ...told.map((key) => ({ key, at: stamp }))];
        return { book: { pending: keep, sent }, out: undefined };
      });
    } catch (error) {
      log.warn("notify: could not send the held notices", { error: String(error) });
    }
  }

  const later = () => {
    const cancel = clock.setTimeout(() => {
      timers.delete(cancel);
      void flush();
    }, debounceMs + 50);

    timers.add(cancel);
  };

  return {
    async add(given: Notify, eventId: string, at?: string) {
      const asked = await askedInChat(opts, given, at);
      if (asked) {
        log.info(`notify: ${given.human} asked ${given.as} for it in chat: nothing sent`, {
          ticket: given.ticket,
        });
      }

      const notice = asked ? { ...given, told: true } : given;
      await book.change(async (b) => ({
        book: holdNotice(b, notice, eventId, now().toISOString()),
        out: undefined,
      }));

      if (!notice.told) {
        later();
      }
    },

    flush,

    stop() {
      for (const cancel of timers) {
        cancel();
      }

      timers.clear();
    },
  };
}

import type { RepoRef } from "@outstaff/core";
import { ciOf } from "#/workstate/derive.js";
import type { PrRecord } from "#/workstate/types.js";
import { readNotified, writeNotified } from "./seen.js";
import type {
  ChecksSplit,
  NoticeDeskOptions,
  NoticeEntry,
  PendingNotices,
} from "./notify.types.js";

/** How long the merge rules read from the code host are used before they are read again. */
const RULES_KEPT_MS = 10 * 60 * 1000;

/** How often a held notice re-reads its ticket's pull requests from the code host; the rescan reads them too. */
const REFRESH_MS = 30 * 1000;

type Verdict = { go: Record<string, string> } | { hold: string } | { drop: string };

const GO: Verdict = { go: {} };
const refOf = (r: PrRecord) => `${r.ref.repo.owner}/${r.ref.repo.name}#${r.ref.number}`;
const short = (sha: string) => sha.slice(0, 7);

/** A review notice about a ticket with pull requests waits for their checks; anything else goes as it is. */
const gated = (e: NoticeEntry) => e.need === "review" && !!e.ticket && e.prs.length > 0;

/**
 * Holds a review notice until the checks on the current head of each of its pull requests finished: only the checks
 * the code host requires before a merge into the pull request's base, when its merge rules name any, else all of them.
 * It goes when they passed (or there are none), naming the head, at most once per head; it is dropped when they failed,
 * since `ci_failed` wakes the author and the next hand-back is held again.
 */
export function createChecksGate(
  opts: Pick<NoticeDeskOptions, "workState" | "vcs" | "store" | "clock" | "logger">,
) {
  const { workState, clock, logger: log } = opts;
  const rules = new Map<string, { at: number; branch?: string; names: string[] }>();
  const refreshed = new Map<string, number>();
  const now = () => clock.now().getTime();

  async function readRules(repo: RepoRef) {
    try {
      const req = await opts.vcs?.mergeRequirements?.(repo);
      return req ? { branch: req.branch, names: req.requiredChecks } : { names: [] };
    } catch (error) {
      log.warn("notify: could not read the merge rules, so every check counts", {
        repo: `${repo.owner}/${repo.name}`,
        error: String(error),
      });

      return { names: [] };
    }
  }

  async function required(rec: PrRecord): Promise<string[]> {
    const key = `${rec.ref.repo.owner}/${rec.ref.repo.name}`;
    let r = rules.get(key);
    if (!r || now() - r.at >= RULES_KEPT_MS) {
      r = { at: now(), ...(await readRules(rec.ref.repo)) };
      rules.set(key, r);
    }

    return r.branch === rec.baseRef ? r.names : [];
  }

  /** The state of the checks that count on the pull request's head: none, pending, failure or success. */
  async function stateOf(rec: PrRecord) {
    const names = await required(rec);
    return ciOf(names.length > 0 ? rec.checks.filter((c) => names.includes(c.name)) : rec.checks);
  }

  /** Whether the human was told of these heads already: the last notice sent about the ticket named them all. */
  async function announced(ticket: string, human: string, heads: Record<string, string>) {
    const told = await readNotified(opts.store, ticket);
    const entries = Object.entries(heads);
    return told?.human === human && entries.every(([ref, head]) => told.prs[ref] === head);
  }

  /** The checks of the open pull requests: the first that failed or still runs decides, else the heads that passed. */
  async function checked(open: readonly PrRecord[]): Promise<Verdict> {
    const heads: Record<string, string> = {};
    for (const rec of open) {
      const state = await stateOf(rec);
      const at = `${refOf(rec)} at ${short(rec.headSha)}`;
      if (state === "failure") {
        return { drop: `checks failed on ${at}: ci_failed wakes the author` };
      }

      if (state === "pending") {
        return { hold: `checks still running on ${at}` };
      }

      if (state === "success") {
        heads[refOf(rec)] = rec.headSha;
      }
    }

    return { go: heads };
  }

  async function verdict(e: NoticeEntry, human: string): Promise<Verdict> {
    const ticket = e.ticket as string;
    const named = new Set(e.prs.map((p) => p.ref));
    const recs = workState.prsOfTicket(ticket).filter((r) => named.has(refOf(r)));
    const open = recs.filter((r) => r.state === "open");
    if (recs.length > 0 && open.length === 0) {
      return { drop: `no pull request of ${ticket} it names is open any more` };
    }

    const v = await checked(open);
    if ("go" in v && Object.keys(v.go).length > 0 && (await announced(ticket, human, v.go))) {
      return { drop: `${human} was told of ${ticket} at these heads already` };
    }

    return v;
  }

  /** The entry as it goes out: each pull request whose checks passed names its head, and what the human sees has it. */
  const withHeads = (e: NoticeEntry, human: string, heads: Record<string, string>): NoticeEntry =>
    Object.keys(heads).length === 0
      ? e
      : {
          ...e,
          prs: e.prs.map((p) => (heads[p.ref] ? { ...p, head: heads[p.ref] } : p)),
          seen: { human, prs: { ...e.seen?.prs, ...heads } },
        };

  /** Says once per notice that it waits for checks. */
  const held = new Set<string>();
  const holding = (p: PendingNotices, e: NoticeEntry, why: string) => {
    const key = `${e.event}|${e.ticket}`;
    if (!held.has(key)) {
      held.add(key);
      log.info(`notify: ${p.as} holds the notice to ${p.human} about ${e.ticket}: ${why}`);
    }
  };

  return {
    /**
     * Re-reads the pull requests of the tickets whose review notices are about to be judged, at most every
     * `REFRESH_MS` a ticket, so a head pushed or a check started since the last read counts. Outside the notice book's
     * lock: what the read raises is judged, and may add a notice.
     */
    async refresh(pending: readonly PendingNotices[]) {
      const tickets = new Set(
        pending.flatMap((p) => p.entries.filter(gated).map((e) => e.ticket!)),
      );

      for (const ticket of tickets) {
        if (now() - (refreshed.get(ticket) ?? -Infinity) < REFRESH_MS) {
          continue;
        }

        refreshed.set(ticket, now());
        await workState.refreshPrsOf(ticket).catch((error: unknown) => {
          log.warn("notify: could not re-read the pull requests", { ticket, error: String(error) });
        });
      }
    },

    /** The human's due notices that go now, and those that wait for checks; the rest are dropped, and logged. */
    async split(p: PendingNotices): Promise<ChecksSplit> {
      const out: ChecksSplit = { go: [], hold: [] };
      for (const e of p.entries) {
        const v = gated(e) ? await verdict(e, p.human) : GO;
        if ("go" in v) {
          out.go.push(withHeads(e, p.human, v.go));
        } else if ("hold" in v) {
          holding(p, e, v.hold);
          out.hold.push(e);
        } else {
          log.info(`notify: nothing sent to ${p.human} about ${e.ticket}: ${v.drop}`, {
            as: p.as,
            event: e.event,
          });
        }
      }

      return out;
    },

    /** Records what the notices sent put in front of the human, per ticket, for the next hand-back to compare with. */
    async sent(human: string, entries: readonly NoticeEntry[]) {
      for (const e of entries) {
        if (e.ticket && e.seen) {
          await writeNotified(opts.store, e.ticket, { human, prs: e.seen.prs });
        }
      }
    },
  };
}

import { parseRepoUrl, type Logger, type TeamConfig } from "@outstaff/core";
import type { PayloadOf } from "@outstaff/protocol";
import type { TicketPrs } from "./protocol/index.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

type PrFilter = PayloadOf<"pr_list">;

const lower = (s: string) => s.toLowerCase();
const login = (s: string) => lower(s).replace(/\[bot\]$/, "");

/** Whether a wanted value, when one is given, is the same as the pull request's, ignoring case. */
const same = (wanted: string | undefined, actual: string | undefined) =>
  wanted === undefined || lower(actual ?? "") === lower(wanted);

/** Whether the author is the person or login asked for; `me` is the caller. */
function byAuthor(p: PrRecord, wanted: string | undefined, person: string): boolean {
  if (wanted === undefined) {
    return true;
  }

  const author = wanted === "me" ? person : wanted;
  return same(author, p.author.person) || login(p.author.login) === login(author);
}

function matches(p: PrRecord, f: PrFilter, person: string): boolean {
  return (
    (f.state === "all" || p.state === f.state) &&
    same(f.ticket, p.ticket) &&
    same(f.repo, `${p.ref.repo.owner}/${p.ref.repo.name}`) &&
    byAuthor(p, f.author, person)
  );
}

/** Open ones first, newest number first; then finished ones, most recently read first. */
function byRecency(a: PrRecord, b: PrRecord): number {
  const open = Number(b.state === "open") - Number(a.state === "open");
  if (open !== 0) {
    return open;
  }

  return a.state === "open" ? b.ref.number - a.ref.number : b.updatedAt.localeCompare(a.updatedAt);
}

/** Answers the protocol's `ticket_prs` and `pr_list` from the work state. */
export function officeTicketPrs(deps: {
  workState: WorkState;
  team: TeamConfig;
  log: Logger;
}): TicketPrs {
  const { workState, team, log } = deps;
  // A pull request opened a moment ago may not have reached the state yet; the answer must not depend on that.
  const catchUp = () =>
    workState.catchUp().catch((error: unknown) => {
      log.warn("could not look for new pull requests", { error: String(error) });
    });

  return {
    async list(person, filter) {
      await catchUp();
      const all = team.repos
        .flatMap((r) => workState.repoPrs(parseRepoUrl(r.url)))
        .filter((p) => matches(p, filter, person))
        .toSorted(byRecency);

      return {
        prs: all.slice(0, filter.limit).map((p) => ({
          ref: workState.prSubject(p.ref),
          number: p.ref.number,
          title: p.title,
          ...(p.url ? { url: p.url } : {}),
          state: p.state,
          draft: p.draft,
          author: p.author.person ?? p.author.login,
          ci: p.ci,
          mergeable: p.mergeable,
          ...(p.review ? { review: p.review } : {}),
          unresolvedThreads: p.unresolvedThreads,
          ...(p.ticket ? { ticket: p.ticket } : {}),
          updatedAt: p.updatedAt,
        })),
        more: Math.max(0, all.length - filter.limit),
      };
    },
    async forDraft(draft) {
      await catchUp();
      const ticket = await workState.ticketForDraft({
        headRef: draft.headRef,
        title: draft.title,
        body: draft.body,
      });

      const status = ticket ? workState.ticket(ticket)?.status : undefined;
      return {
        ...(ticket ? { ticket } : {}),
        ...(status ? { status } : {}),
        prs: ticket
          ? workState
              .prsOfTicket(ticket)
              .toSorted((a, b) => a.ref.number - b.ref.number)
              .map((p) => ({
                ref: workState.prSubject(p.ref),
                number: p.ref.number,
                title: p.title,
                ...(p.url ? { url: p.url } : {}),
                state: p.state,
                authorKind: p.author.kind,
              }))
          : [],
      };
    },
  };
}

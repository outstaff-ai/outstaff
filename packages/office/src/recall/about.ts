import { parseRepoUrl, type PrRef, type TeamConfig } from "@outstaff/core";
import type { MomentRef } from "#/store/types.js";
import type { AboutState } from "./types.js";

const TICKET = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PR_NUMBER = /(?:^|[#/])(\d+)$/;

/** The pull requests numbered so: those the work state keeps, and that number in each of the team's repositories. */
function prRefs(
  state: AboutState,
  team: Pick<TeamConfig, "repos">,
  text: string,
  number: number,
): MomentRef[] {
  const named = (repo: PrRef["repo"]) =>
    !text.includes("/") || text.toLowerCase().includes(`${repo.owner}/${repo.name}`.toLowerCase());

  const refs = [
    ...state.pullRequests(number).map((p) => p.ref),
    ...team.repos.map((r) => ({ repo: parseRepoUrl(r.url), number })),
  ]
    .filter((p) => named(p.repo))
    .map((p) => state.prSubject(p));

  return [...new Set(refs)].map((ref) => ({ type: "pr", ref }));
}

/**
 * What `--about` names: a ticket by its key, a pull request by its number, `#number`, `owner/repo#number` or link, or
 * a document by its id. A bare number may be a pull request or a document, so it is both.
 */
export function aboutRefs(
  state: AboutState,
  team: Pick<TeamConfig, "repos">,
  about: string,
): MomentRef[] {
  const text = about.trim();
  if (TICKET.test(text)) {
    return [...new Set([text, text.toUpperCase()])].map((ref) => ({ type: "ticket", ref }));
  }

  const number = PR_NUMBER.exec(text.replace(/\/pull\/(\d+)\/?$/, "/$1"))?.[1];
  const prs = number === undefined ? [] : prRefs(state, team, text, Number(number));
  return /^\d+$/.test(text) || number === undefined ? [...prs, { type: "doc", ref: text }] : prs;
}

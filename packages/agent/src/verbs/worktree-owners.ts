import type { RepoRef } from "@outstaff/core";
import { safeId } from "#/repos/workspaces.js";
import type { OfficeWorkItem } from "./office.types.js";
import type { AgentEnv } from "./types.js";
import type { OpenPr, WorkIndex } from "./worktree-owners.types.js";

/** How to find the work a worktree belongs to, and what to do with it: attach from chat, leave it from a round. */
const LOOK = {
  chat: "Check ost work list and ost pr list for the work it belongs to, and attach the request to that work with ost work attach.",
  round:
    "Check ost work list and ost pr list for the work it belongs to, and leave the change to that work: comment the request on its ticket or pull request, and say so in your hand-back.",
};

/** Where a refusal in a work round says to leave the request. */
function leaveOn(ticket: string | undefined, pr: string | undefined): string {
  const on = [ticket && `its ticket ${ticket}`, pr && `its pull request ${shortPr(pr)}`].filter(
    Boolean,
  );

  return on.join(" or ");
}

/** The person's open work and the team's open pull requests; empty when the office cannot say. */
export async function workIndex(env: Pick<AgentEnv, "office">): Promise<WorkIndex> {
  const office = env.office;
  if (!office) {
    return { items: [], prs: [] };
  }

  const [items, prs] = await Promise.all([
    office.work({}).catch(() => []),
    office.prList({ state: "open", limit: 200 }).then(
      (r) => r.prs,
      () => [],
    ),
  ]);

  return { items, prs };
}

/** `shop-kit#1` for `github.com/acme/shop-kit#1`. */
const shortPr = (ref: string) => ref.replace(/^.*\//, "");

/** Whether the pull request `ref` (`[host/]owner/name#n`) is one of `repo`. */
function inRepo(ref: string, repo: Pick<RepoRef, "owner" | "name">): boolean {
  const path = ref.replace(/#\d+$/, "").toLowerCase();
  const full = `${repo.owner}/${repo.name}`.toLowerCase();
  return path === full || path.endsWith(`/${full}`);
}

/** The pull request an item works on in `repo`: its subject, else the open one of its ticket there. */
function prOf(item: OfficeWorkItem, repo: Pick<RepoRef, "owner" | "name">, prs: OpenPr[]) {
  if (item.pr) {
    return item.pr;
  }

  const open = prs.filter((p) => item.ticketKey && p.ticket === item.ticketKey);
  return (open.find((p) => inRepo(p.ref, repo)) ?? (open.length === 1 ? open[0] : undefined))?.ref;
}

/**
 * What to say about a worktree another work item holds: the work it belongs to and how to reach it. A chat session
 * attaches the request to that work (`--confirmed`: the human in the chat directs it); a work round, which cannot
 * attach, leaves the change to that work. `dir` is the worktree's folder name, the item's path-safe id.
 */
export function ownerHint(
  dir: string,
  repo: Pick<RepoRef, "owner" | "name">,
  index: WorkIndex,
  session: "chat" | "round",
): string {
  const item = index.items.find((i) => safeId(i.id) === dir);
  if (!item) {
    return `This is the worktree of another work item (${dir}), not of this one. ${LOOK[session]}`;
  }

  const pr = prOf(item, repo, index.prs);
  const target = pr ?? item.ticketKey;
  if (!target) {
    return `This is the worktree of work item ${item.id} ("${item.title}"), not of this one. ${LOOK[session]}`;
  }

  const label = item.ticketKey
    ? `${item.ticketKey}${pr ? ` (${shortPr(pr)})` : ""}`
    : shortPr(pr ?? target);

  if (session === "round") {
    return `This is the worktree of ${label}, not of this item. Leave the change to that work: comment the request on ${leaveOn(item.ticketKey, pr)}, and say so in your hand-back.`;
  }

  return `This is the worktree of ${label}. To change it, attach the request to that work: ost work attach ${target} --confirmed.`;
}

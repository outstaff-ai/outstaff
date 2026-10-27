import type { TeamConfig } from "@outstaff/core";
import type { Ref, WorkItem } from "#/store/index.js";
import type { PrRecord, TicketRecord } from "./types.js";
import type { PrOps, RefreshCtx, TicketOps, WorkstateCore } from "./core.types.js";
import { docOpen, isTerminal, openPrs } from "./derive.js";
import { docNode, prNode, ROOT, ticketNode } from "./links.js";
import { addPickup } from "./ready.js";

type Latest = Map<string, { at: string; person: string; done: boolean }>;

/** Answering a question on a ticket, or trying to unblock it, does not make the agent the one who worked on it. */
const workedOn = (item: WorkItem) =>
  Boolean(item.subject) &&
  item.status !== "queued" &&
  item.kind !== "asked" &&
  item.kind !== "unblock";

/** The ticket an item worked on: its own subject, or the ticket of its pull request. */
function ticketOf(item: WorkItem, prs: Map<string, PrRecord>): string | undefined {
  if (item.subject?.type === "ticket") {
    return item.subject.ref;
  }

  return item.subject?.type === "pr" ? prs.get(item.subject.ref)?.ticket : undefined;
}

/** The latest item that worked on each ticket. */
function latestWork(items: WorkItem[], prs: Map<string, PrRecord>): Latest {
  const latest: Latest = new Map();
  for (const item of items.filter(workedOn)) {
    const key = ticketOf(item, prs);
    const seen = key && latest.get(key);
    if (key && (!seen || seen.at < item.updatedAt)) {
      latest.set(key, { at: item.updatedAt, person: item.person, done: item.status === "done" });
    }
  }

  return latest;
}

/** A ticket still worth reading from the tracker. */
const live = (rec: TicketRecord) => !rec.goneAt && !isTerminal(rec.status);

const trackerIds = (team: TeamConfig) =>
  team.people.flatMap((p) => (p.identities?.tracker ? [p.identities.tracker] : []));

/** Rebuilds the records: from the store on open, and from the ports on a rescan. */
export function createRescan(core: WorkstateCore, ops: TicketOps & PrOps) {
  const { store, vcs, tracker, team, clock, retentionMs, repos, prs, tickets, docs } = core;
  const { workers, handedBack, pickups, prSubject } = core;
  const { refreshPr, refreshTicket, saveTicket, toTicket } = ops;
  const refreshPickups = (items: WorkItem[]) => {
    pickups.clear();
    for (const item of items) {
      const key = ticketOf(item, prs);
      if (key) {
        addPickup(pickups, item, key);
      }
    }
  };

  const refreshWorkers = async () => {
    const items = await store.listItems();
    refreshPickups(items);
    const latest = latestWork(items, prs);
    workers.clear();
    handedBack.clear();
    for (const [key, v] of latest) {
      workers.set(key, v.person);
      if (v.done) {
        handedBack.add(key);
      }
    }
  };

  /** Forgets the records `gone` says are finished and old enough. */
  const forget = async <T>(
    records: Map<string, T>,
    node: (key: string) => Ref,
    gone: (rec: T) => boolean,
  ) => {
    for (const [key, rec] of records) {
      if (gone(rec)) {
        records.delete(key);
        await store.unlink(ROOT, node(key), "tracks");
      }
    }
  };

  const prune = async () => {
    const cutoff = clock.now().getTime() - retentionMs;
    const old = (at: string) => Date.parse(at) < cutoff;
    await forget(prs, prNode, (p) => p.state !== "open" && old(p.updatedAt));
    await forget(
      tickets,
      ticketNode,
      (t) => (isTerminal(t.status) || Boolean(t.goneAt)) && old(t.updatedAt),
    );

    await forget(docs, docNode, (d) => !docOpen(core, d) && old(d.touchedAt));
  };

  const rescanPrs = async (ctx: RefreshCtx) => {
    const seen = new Set<string>();
    for (const repo of repos) {
      for (const listed of await vcs.listPullRequests(repo, { state: "open" })) {
        const ref = { repo: listed.repo, number: listed.number };
        seen.add(prSubject(ref));
        await refreshPr(ctx, ref, { baseline: !prs.has(prSubject(ref)) });
      }
    }

    // Stored as open, no longer listed: merged or closed while nobody was watching.
    for (const rec of openPrs(core).filter((p) => !seen.has(prSubject(p.ref)))) {
      await refreshPr(ctx, rec.ref);
    }
  };

  const rescanTickets = async () => {
    if (!tracker) {
      return;
    }

    for (const rec of tickets.values()) {
      if (live(rec)) {
        await refreshTicket(rec.key);
      }
    }

    for (const assignee of trackerIds(team)) {
      const issues = await tracker.listIssues({ assignee, limit: 100 });
      for (const issue of issues.filter((i) => !isTerminal(i.status.canonical))) {
        await saveTicket(toTicket(issue, tickets.get(issue.key)));
      }
    }
  };

  const doRescan = async (ctx: RefreshCtx) => {
    await rescanPrs(ctx);
    await rescanTickets();
    await prune();
    await refreshWorkers();
  };

  const byType = new Map<string, Map<string, unknown>>([
    ["pr", prs],
    ["ticket", tickets],
    ["doc", docs],
  ]);

  const load = async () => {
    for (const link of await store.queryLinks({ from: ROOT, relation: "tracks" })) {
      const subject = await store.getSubject(link.to.type, link.to.ref);
      if (subject) {
        byType.get(link.to.type)?.set(link.to.ref, subject.data);
      }
    }

    await refreshWorkers();
  };

  return { refreshWorkers, doRescan, load };
}

import type { DocRecord, PrRecord, TicketRecord } from "./types.js";
import type { PrOps, RefreshCtx, TicketOps, WorkstateCore } from "./core.types.js";
import { docOpen, openPrs, TERMINAL } from "./derive.js";
import { docNode, prNode, ROOT, ticketNode } from "./links.js";

/** Rebuilds the records: from the store on open, and from the ports on a rescan. */
export function createRescan(core: WorkstateCore, ops: TicketOps & PrOps) {
  const {
    store,
    vcs,
    tracker,
    team,
    clock,
    retentionMs,
    repos,
    prs,
    tickets,
    docs,
    workers,
    handedBack,
    prSubject,
  } = core;

  const { refreshPr, refreshTicket, saveTicket, toTicket } = ops;
  const refreshWorkers = async () => {
    const latest = new Map<string, { at: string; person: string; done: boolean }>();
    for (const item of await store.listItems()) {
      // Answering a question on a ticket, or trying to unblock it, does not make the agent the one who worked on it.
      if (
        !item.subject ||
        item.status === "queued" ||
        item.kind === "asked" ||
        item.kind === "unblock"
      ) {
        continue;
      }

      const key =
        item.subject.type === "ticket"
          ? item.subject.ref
          : item.subject.type === "pr"
            ? prs.get(item.subject.ref)?.ticket
            : undefined;

      const seen = key && latest.get(key);
      if (key && (!seen || seen.at < item.updatedAt)) {
        latest.set(key, { at: item.updatedAt, person: item.person, done: item.status === "done" });
      }
    }

    workers.clear();
    handedBack.clear();
    for (const [key, v] of latest) {
      workers.set(key, v.person);
      if (v.done) {
        handedBack.add(key);
      }
    }
  };

  const prune = async () => {
    const cutoff = clock.now().getTime() - retentionMs;
    const old = (at: string) => Date.parse(at) < cutoff;
    for (const [key, p] of prs) {
      if (p.state !== "open" && old(p.updatedAt)) {
        prs.delete(key);
        await store.unlink(ROOT, prNode(key), "tracks");
      }
    }

    for (const [key, t] of tickets) {
      if (((t.status && TERMINAL.has(t.status)) || t.goneAt) && old(t.updatedAt)) {
        tickets.delete(key);
        await store.unlink(ROOT, ticketNode(key), "tracks");
      }
    }

    for (const [id, d] of docs) {
      if (!docOpen(core, d) && old(d.touchedAt)) {
        docs.delete(id);
        await store.unlink(ROOT, docNode(id), "tracks");
      }
    }
  };

  const doRescan = async (ctx: RefreshCtx) => {
    const seen = new Set<string>();
    for (const repo of repos) {
      for (const listed of await vcs.listPullRequests(repo, { state: "open" })) {
        const ref = { repo: listed.repo, number: listed.number };
        seen.add(prSubject(ref));
        await refreshPr(ctx, ref, { baseline: !prs.has(prSubject(ref)) });
      }
    }

    // Stored as open, no longer listed: merged or closed while nobody was watching.
    for (const rec of openPrs(core)) {
      if (!seen.has(prSubject(rec.ref))) {
        await refreshPr(ctx, rec.ref);
      }
    }

    if (tracker) {
      for (const rec of tickets.values()) {
        if (!rec.goneAt && (!rec.status || !TERMINAL.has(rec.status))) {
          await refreshTicket(rec.key);
        }
      }

      for (const person of team.people) {
        const id = person.identities?.tracker;
        if (!id) {
          continue;
        }

        for (const issue of await tracker.listIssues({ assignee: id, limit: 100 })) {
          if (issue.status.canonical && TERMINAL.has(issue.status.canonical)) {
            continue;
          }

          await saveTicket(toTicket(issue, tickets.get(issue.key)));
        }
      }
    }

    await prune();
    await refreshWorkers();
  };

  const load = async () => {
    for (const link of await store.queryLinks({ from: ROOT, relation: "tracks" })) {
      const subject = await store.getSubject(link.to.type, link.to.ref);
      if (link.to.type === "pr" && subject) {
        prs.set(link.to.ref, subject.data as PrRecord);
      } else if (link.to.type === "ticket" && subject) {
        tickets.set(link.to.ref, subject.data as TicketRecord);
      } else if (link.to.type === "doc" && subject) {
        docs.set(link.to.ref, subject.data as DocRecord);
      }
    }

    await refreshWorkers();
  };

  return { refreshWorkers, doRescan, load };
}

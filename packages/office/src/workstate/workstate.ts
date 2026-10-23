import { parseRepoUrl, PortError, repoKey } from "@outstaff/core";
import type {
  CanonicalStatus,
  Issue,
  Member,
  PrRef,
  PullRequest,
  RepoRef,
  WorkflowEvent,
  WorkflowPr,
} from "@outstaff/core";
import type { Cancel } from "../clock.js";
import type { Ref } from "../store/index.js";
import { ticketCandidates } from "./infer.js";
import type {
  CiState,
  CurrentWork,
  PrRecord,
  TicketRecord,
  WorkState,
  WorkstateHandler,
  WorkstateOptions,
} from "./types.js";

const ROOT: Ref = { type: "workstate", ref: "index" };
const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_RETENTION_MS = 14 * 24 * 3_600_000;
const TERMINAL = new Set(["done", "canceled"]);
const prNode = (key: string): Ref => ({ type: "pr", ref: key });
const ticketNode = (key: string): Ref => ({ type: "ticket", ref: key });
const personNode = (handle: string): Ref => ({ type: "person", ref: handle });
const ACTOR = { kind: "automation", id: "workstate" } as const;

interface Fresh {
  event: WorkflowEvent;
  externalId: string;
}

interface Ctx {
  fresh: Fresh[];
}

const ciOf = (checks: PrRecord["checks"]): CiState => {
  if (checks.length === 0) {
    return "none";
  }

  if (checks.some((c) => c.status === "failure")) {
    return "failure";
  }

  return checks.some((c) => c.status === "pending") ? "pending" : "success";
};

const notFound = (error: unknown) => error instanceof PortError && error.code === "not_found";

/** Opens the work state and loads what the store already knows. */
export async function createWorkState(opts: WorkstateOptions): Promise<WorkState> {
  const { store, ports, team, clock, logger } = opts;
  const { vcs, tracker } = ports;
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const repos: RepoRef[] = team.repos.map((r) => {
    const { host, owner, name } = parseRepoUrl(r.url);
    return { host, owner, name };
  });

  const defaultHost = repos[0]?.host ?? "git.acme.example";
  const vcsPeople = new Map<string, string>();
  const trackerPeople = new Map<string, string>();
  for (const p of team.people) {
    if (p.identities?.vcs) {
      vcsPeople.set(p.identities.vcs.toLowerCase(), p.handle);
    }

    if (p.identities?.tracker) {
      trackerPeople.set(p.identities.tracker, p.handle);
    }
  }

  const prs = new Map<string, PrRecord>();
  const tickets = new Map<string, TicketRecord>();
  const workers = new Map<string, string>();
  const notTickets = new Set<string>();
  const handlers: WorkstateHandler[] = [];

  const sameRepo = (a: RepoRef, b: RepoRef) => repoKey(a, defaultHost) === repoKey(b, defaultHost);
  const prSubject = (pr: PrRef) => `${repoKey(pr.repo, defaultHost)}#${pr.number}`;

  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const relink = async (from: Ref, relation: string, prev?: Ref, next?: Ref) => {
    if (prev?.type === next?.type && prev?.ref === next?.ref) {
      return;
    }

    if (prev) {
      await store.unlink(from, prev, relation);
    }

    if (next) {
      await store.link(from, next, relation);
    }
  };

  const synthetic = async (
    ctx: Ctx,
    type: "pr.conflicted" | "pr.ci_failed",
    rec: PrRecord,
    data: Record<string, unknown>,
  ) => {
    const externalId = `${type}:${prSubject(rec.ref)}:${rec.headSha}`;
    const event: WorkflowEvent = {
      type,
      subject: { pr: rec.ref, ...(rec.ticket ? { ticket: rec.ticket } : {}) },
      actor: { ...ACTOR },
      data: { ...data, sha: rec.headSha, at: clock.now().toISOString() },
    };

    // The stored shape is the one intake delivers, so a crash before delivery is repaired by intake.
    const fresh = await store.recordEvent({
      source: "workstate",
      externalId,
      type,
      payload: { raw: { externalId, type }, event, trusted: true },
    });

    if (fresh) {
      ctx.fresh.push({ event, externalId });
    }
  };

  const deliver = async (list: Fresh[]) => {
    if (handlers.length === 0) {
      return;
    }

    for (const { event, externalId } of list) {
      let ok = true;
      for (const handler of handlers) {
        try {
          await handler(event, { source: "workstate", externalId, trusted: true });
        } catch (error) {
          ok = false;
          logger.warn("workstate handler failed", { type: event.type, error: String(error) });
        }
      }

      if (ok) {
        await store.markProcessed("workstate", externalId);
      }
    }
  };

  // Tickets

  const assigneeOf = (member?: Member): TicketRecord["assignee"] => {
    if (!member) {
      return undefined;
    }

    if (member.kind === "agent") {
      const handle =
        trackerPeople.get(member.id) ?? (member.username && trackerPeople.get(member.username));

      return { id: handle || member.id, kind: "agent" };
    }

    return { id: member.username ?? member.id, kind: "human" };
  };

  const saveTicket = async (rec: TicketRecord) => {
    const prev = tickets.get(rec.key);
    tickets.set(rec.key, rec);
    await store.upsertSubject("ticket", rec.key, rec);
    await store.link(ROOT, ticketNode(rec.key), "tracks");
    const person = (a?: TicketRecord["assignee"]) =>
      a?.kind === "agent" && team.people.some((p) => p.handle === a.id)
        ? personNode(a.id)
        : undefined;

    await relink(ticketNode(rec.key), "assigned_to", person(prev?.assignee), person(rec.assignee));
  };

  const toTicket = (issue: Issue, prev?: TicketRecord): TicketRecord => {
    const status = issue.status.canonical ?? prev?.status;
    const assignee = assigneeOf(issue.assignee);
    return {
      key: issue.key,
      title: issue.title,
      url: issue.url,
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
      labels: [...issue.labels],
      ...(prev?.requester ? { requester: prev.requester } : {}),
      updatedAt: clock.now().toISOString(),
    };
  };

  const refreshTicket = async (key: string, event?: WorkflowEvent) => {
    const prev = tickets.get(key);
    let rec: TicketRecord;
    if (tracker) {
      try {
        rec = toTicket(await tracker.getIssue(key), prev);
      } catch (error) {
        if (notFound(error)) {
          logger.warn("ticket not found", { key });
          return;
        }

        throw error;
      }
    } else {
      // Without a tracker the events are all there is to go on.
      rec = prev ?? { key, title: key, labels: [], updatedAt: clock.now().toISOString() };
      const to = event?.data["to"];
      if (event?.type === "ticket.moved" && typeof to === "string") {
        rec = { ...rec, status: to as CanonicalStatus };
      }
    }

    const human = event?.actor.kind === "human" && event.data["untrusted"] !== true;
    const requestedBy =
      event && human && !rec.requester && ["ticket.created", "ticket.assigned"].includes(event.type)
        ? event.actor.id
        : undefined;

    await saveTicket(requestedBy ? { ...rec, requester: requestedBy } : rec);
  };

  const ensureTicket = async (key: string): Promise<boolean> => {
    if (tickets.has(key)) {
      return true;
    }

    if (notTickets.has(key)) {
      return false;
    }

    await refreshTicket(key);
    if (tickets.has(key)) {
      return true;
    }

    notTickets.add(key);
    return false;
  };

  const inferTicket = async (pr: PullRequest, prev?: PrRecord): Promise<string | undefined> => {
    const candidates = ticketCandidates({ headRef: pr.head.ref, title: pr.title, body: pr.body });
    if (prev?.ticket && candidates.includes(prev.ticket)) {
      return prev.ticket;
    }

    for (const key of candidates) {
      if (!tracker || (await ensureTicket(key))) {
        return key;
      }
    }

    return undefined;
  };

  // Pull requests

  const openPrs = (repo?: RepoRef) =>
    [...prs.values()].filter((p) => p.state === "open" && (!repo || sameRepo(p.ref.repo, repo)));

  const restack = async (repo: RepoRef) => {
    const open = openPrs(repo);
    for (const rec of open) {
      const base = open.find((o) => o !== rec && o.headRef === rec.baseRef);
      const next = base && prSubject(base.ref);
      if (next === rec.stackedOn) {
        continue;
      }

      const key = prSubject(rec.ref);
      const updated: PrRecord = { ...rec };
      if (next) {
        updated.stackedOn = next;
      } else {
        delete updated.stackedOn;
      }

      prs.set(key, updated);
      await store.upsertSubject("pr", key, updated);
      await relink(
        prNode(key),
        "stacked_on",
        rec.stackedOn ? prNode(rec.stackedOn) : undefined,
        next ? prNode(next) : undefined,
      );
    }
  };

  const refreshPr = async (
    ctx: Ctx,
    ref: PrRef,
    o: { baseline?: boolean; wait?: boolean; review?: string } = {},
  ): Promise<void> => {
    const known = prs.get(prSubject(ref));
    let pr: PullRequest;
    try {
      pr = await vcs.getPullRequest(ref.repo, ref.number, { waitForMergeable: o.wait ?? false });
    } catch (error) {
      if (notFound(error)) {
        logger.warn("pull request not found", { pr: prSubject(ref) });
        return;
      }

      throw error;
    }

    const key = prSubject({ repo: pr.repo, number: pr.number });
    const prev = prs.get(key) ?? known;
    const open = pr.state === "open";
    let checks = prev?.checks ?? [];
    let unresolved = prev?.unresolvedThreads ?? 0;
    if (open) {
      const [found, threads] = await Promise.all([
        vcs.checks(pr.repo, pr.head.sha),
        vcs.reviewThreads(pr.repo, pr.number),
      ]);

      checks = found.map((c) => ({ name: c.name, status: c.status }));
      unresolved = threads.filter((t) => !t.resolved).length;
    }

    const person = vcsPeople.get(pr.author.login.toLowerCase());
    const review = o.review ?? prev?.review;
    const ticket = await inferTicket(pr, prev);
    const rec: PrRecord = {
      ref: { repo: pr.repo, number: pr.number },
      title: pr.title,
      url: pr.url,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      draft: pr.draft,
      state: pr.state,
      // A finished pull request has no mergeability worth reporting.
      mergeable: open ? pr.mergeable : (prev?.mergeable ?? pr.mergeable),
      author: { login: pr.author.login, kind: pr.author.kind, ...(person ? { person } : {}) },
      checks,
      ci: ciOf(checks),
      unresolvedThreads: unresolved,
      ...(review ? { review } : {}),
      ...(ticket ? { ticket } : {}),
      ...(prev?.stackedOn ? { stackedOn: prev.stackedOn } : {}),
      updatedAt: clock.now().toISOString(),
    };

    // A pull request seen for the first time during a rescan sets the baseline instead of raising events.
    if (open && (prev || !o.baseline)) {
      if (rec.mergeable === "conflicting" && prev?.mergeable !== "conflicting") {
        await synthetic(ctx, "pr.conflicted", rec, { base: rec.baseRef });
      }

      if (rec.ci === "failure" && prev?.ci !== "failure") {
        const failing = checks.filter((c) => c.status === "failure").map((c) => c.name);
        await synthetic(ctx, "pr.ci_failed", rec, { failing });
      }
    }

    prs.set(key, rec);
    await store.upsertSubject("pr", key, rec);
    await store.link(ROOT, prNode(key), "tracks");
    await relink(
      prNode(key),
      "implements",
      prev?.ticket ? ticketNode(prev.ticket) : undefined,
      rec.ticket ? ticketNode(rec.ticket) : undefined,
    );

    await relink(
      prNode(key),
      "authored_by",
      prev?.author.person ? personNode(prev.author.person) : undefined,
      person ? personNode(person) : undefined,
    );

    await restack(rec.ref.repo);
  };

  // Who last worked on what

  const refreshWorkers = async () => {
    const latest = new Map<string, { at: string; person: string }>();
    for (const item of await store.listItems()) {
      if (!item.subject || item.status === "queued") {
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
        latest.set(key, { at: item.updatedAt, person: item.person });
      }
    }

    workers.clear();
    for (const [key, v] of latest) {
      workers.set(key, v.person);
    }
  };

  // Events

  const handle = async (ctx: Ctx, event: WorkflowEvent) => {
    const pr = event.subject.pr;
    switch (event.type) {
      case "pr.opened":
      case "pr.comment":
      case "pr.closed":
      case "pr.merged":
      case "pr.review_submitted": {
        if (!pr) {
          return;
        }

        const state = event.data["state"];
        const review =
          event.type === "pr.review_submitted" && typeof state === "string" && state !== "commented"
            ? state
            : undefined;

        await refreshPr(ctx, pr, review ? { review } : {});
        if (event.type === "pr.merged") {
          for (const other of openPrs(pr.repo)) {
            if (prSubject(other.ref) !== prSubject(pr)) {
              await refreshPr(ctx, other.ref, { wait: true });
            }
          }
        }

        return;
      }

      case "ticket.created":
      case "ticket.assigned":
      case "ticket.moved":
      case "ticket.commented":
        if (event.subject.ticket) {
          await refreshTicket(event.subject.ticket, event);
        }

        return;
      default:
        // Our own synthetic events and the ones for the engine only.
        return;
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
      if (t.status && TERMINAL.has(t.status) && old(t.updatedAt)) {
        tickets.delete(key);
        await store.unlink(ROOT, ticketNode(key), "tracks");
      }
    }
  };

  const doRescan = async (ctx: Ctx) => {
    const seen = new Set<string>();
    for (const repo of repos) {
      for (const listed of await vcs.listPullRequests(repo, { state: "open" })) {
        const ref = { repo: listed.repo, number: listed.number };
        seen.add(prSubject(ref));
        await refreshPr(ctx, ref, { baseline: !prs.has(prSubject(ref)) });
      }
    }

    // Stored as open, no longer listed: merged or closed while nobody was watching.
    for (const rec of openPrs()) {
      if (!seen.has(prSubject(rec.ref))) {
        await refreshPr(ctx, rec.ref);
      }
    }

    if (tracker) {
      for (const rec of tickets.values()) {
        if (!rec.status || !TERMINAL.has(rec.status)) {
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
      }
    }

    await refreshWorkers();
  };

  const toWorkflowPr = (p: PrRecord): WorkflowPr => ({
    ref: p.ref,
    title: p.title,
    ...(p.url ? { url: p.url } : {}),
    headRef: p.headRef,
    baseRef: p.baseRef,
    draft: p.draft,
    author: { ...p.author },
  });

  let timer: Cancel | undefined;
  let running = false;

  const schedule = () => {
    timer = clock.setTimeout(() => {
      void state.rescan().then(
        () => running && schedule(),
        (error: unknown) => {
          logger.warn("workstate rescan failed", { error: String(error) });
          if (running) {
            schedule();
          }
        },
      );
    }, refreshMs);
  };

  const state: WorkState = {
    prSubject,
    onEvent: (h) => void handlers.push(h),

    async apply(event) {
      const ctx: Ctx = { fresh: [] };
      await locked(async () => {
        await handle(ctx, event);
        await refreshWorkers();
      });

      await deliver(ctx.fresh);
    },

    async rescan() {
      const ctx: Ctx = { fresh: [] };
      await locked(() => doRescan(ctx));
      await deliver(ctx.fresh);
    },

    refreshWorkers: () => locked(refreshWorkers),

    async start() {
      if (running) {
        return;
      }

      running = true;
      schedule();
    },

    async stop() {
      running = false;
      timer?.();
      timer = undefined;
      await chain;
    },

    ticketForPr: (pr) => prs.get(prSubject(pr))?.ticket,
    ticketStatus: (t) => tickets.get(t)?.status,
    assignee: (t) => tickets.get(t)?.assignee,
    pullRequest(pr) {
      const rec = prs.get(prSubject(pr));
      return rec && toWorkflowPr(rec);
    },
    lastWorker: (t) => workers.get(t),
    requester: (t) => tickets.get(t)?.requester,
    hasLabel: (t, label) => tickets.get(t)?.labels.includes(label) ?? false,

    stackedOn(repo, branch) {
      // Everything above the branch, bottom first.
      const out: PrRecord[] = [];
      const queue = [branch];
      while (queue.length > 0) {
        const base = queue.shift()!;
        for (const p of openPrs(repo)) {
          if (p.baseRef === base && !out.includes(p)) {
            out.push(p);
            queue.push(p.headRef);
          }
        }
      }

      return out.map(toWorkflowPr);
    },

    personForRole(role) {
      const matches = team.people.filter((p) => p.role === role || p.extends?.includes(role));
      return matches.length === 1 ? matches[0]!.handle : undefined;
    },

    currentWork(person): CurrentWork {
      const mine = [...tickets.values()].filter(
        (t) =>
          t.assignee?.kind === "agent" &&
          t.assignee.id === person &&
          !(t.status && TERMINAL.has(t.status)),
      );

      const keys = new Set(mine.map((t) => t.key));
      const prList = openPrs().filter(
        (p) => p.author.person === person || (p.ticket !== undefined && keys.has(p.ticket)),
      );

      const refs = (key: string) =>
        prList.filter((p) => p.ticket === key).map((p) => prSubject(p.ref));

      return {
        person,
        tickets: mine.map((t) => ({
          key: t.key,
          title: t.title,
          ...(t.status ? { status: t.status } : {}),
          prs: refs(t.key),
        })),
        prs: prList.map((p) => ({
          ref: prSubject(p.ref),
          number: p.ref.number,
          title: p.title,
          ...(p.url ? { url: p.url } : {}),
          state: p.state,
          draft: p.draft,
          ci: p.ci,
          mergeable: p.mergeable,
          unresolvedThreads: p.unresolvedThreads,
          ...(p.review ? { review: p.review } : {}),
          ...(p.ticket ? { ticket: p.ticket } : {}),
          ...(p.stackedOn ? { stackedOn: p.stackedOn } : {}),
        })),
      };
    },
  };

  await load();
  return state;
}

/** A few lines for the agent's session context. */
export function formatCurrentWork(work: CurrentWork): string {
  if (work.tickets.length === 0 && work.prs.length === 0) {
    return `${work.person} has no open tickets or pull requests.`;
  }

  const lines: string[] = [];
  for (const t of work.tickets) {
    lines.push(`Ticket ${t.key} (${t.status ?? "unknown"}): ${t.title}`);
  }

  for (const p of work.prs) {
    const notes = [
      p.draft ? "draft" : "",
      `CI ${p.ci}`,
      p.mergeable === "conflicting" ? "conflicts" : "",
      p.unresolvedThreads > 0 ? `${p.unresolvedThreads} unresolved threads` : "",
      p.review ? `review ${p.review}` : "",
      p.ticket ? `for ${p.ticket}` : "",
      p.stackedOn ? `stacked on ${p.stackedOn}` : "",
    ].filter(Boolean);

    lines.push(`PR ${p.ref}: ${p.title} (${notes.join(", ")})`);
  }

  return lines.join("\n");
}

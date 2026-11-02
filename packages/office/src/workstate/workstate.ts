import { parseRepoUrl, repoKey, vcsAgentLogins } from "@outstaff/core";
import type { PrRef, RepoRef } from "@outstaff/core";
import type { Cancel } from "#/types.js";
import type { RefreshCtx, WorkstateCore } from "./core.types.js";
import { currentWork, docOpen, stackedOn, toWorkflowPr } from "./derive.js";
import { blockedAgent, inRound } from "./blocked.js";
import { createDocs } from "./docs.js";
import { createEvents } from "./events.js";
import { createMergeChecks } from "./merge-checks.js";
import { visible } from "./open.js";
import { createPrs } from "./prs.js";
import { readyTickets } from "./ready.js";
import { createRequesters } from "./requesters.js";
import { createRescan } from "./rescan.js";
import { createTickets } from "./tickets.js";
import { createUnblock } from "./unblock.js";
import type { WorkState, WorkstateOptions } from "./types.js";

const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_RETENTION_MS = 14 * 24 * 3_600_000;

/** Merges are followed as often as events are polled, so a ticket closes soon after its merge's checks pass. */
const followInterval = (opts: WorkstateOptions) =>
  opts.followIntervalMs ?? (opts.team.office?.poll_interval_seconds ?? 60) * 1000;

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

  const ticketLinks = (repo?: RepoRef): string[] =>
    team.repos.flatMap((r, i) =>
      (r.ticket_link ?? []).filter(() => !repo || (repos[i] && sameRepo(repos[i], repo))),
    );

  const defaultHost = repos[0]?.host ?? "git.acme.example";
  const trackerPeople = new Map<string, string>();
  for (const p of team.people) {
    if (p.identities?.tracker) {
      trackerPeople.set(p.identities.tracker, p.handle);
    }
  }

  const sameRepo = (a: RepoRef, b: RepoRef) => repoKey(a, defaultHost) === repoKey(b, defaultHost);
  const prSubject = (pr: PrRef) => `${repoKey(pr.repo, defaultHost)}#${pr.number}`;
  const core: WorkstateCore = {
    store,
    vcs,
    tracker,
    team,
    clock,
    logger,
    retentionMs,
    repos,
    vcsPeople: vcsAgentLogins(team),
    trackerPeople,
    prs: new Map(),
    tickets: new Map(),
    docs: new Map(),
    workers: new Map(),
    handedBack: new Set(),
    work: new Map(),
    pickups: new Map(),
    notTickets: new Set(),
    handlers: [],
    sameRepo,
    prSubject,
    ticketLinks,
  };

  const { prs, tickets, docs, workers, handedBack, work, handlers } = core;

  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const ticketOps = createTickets(core);
  const unblockOps = createUnblock(core, ticketOps);
  const prOps = createPrs(core, ticketOps);
  const requesters = createRequesters(core, ticketOps);
  const { saveDoc, touchDoc, linkDoc } = createDocs(core);
  const { followMerges } = createMergeChecks(core);
  const { refreshPr, ticketOfDraft } = prOps;
  const { deliver, handle } = createEvents(core, {
    ...ticketOps,
    ...unblockOps,
    ...prOps,
    ...requesters,
    saveDoc,
    touchDoc,
    linkDoc,
    followMerges,
  });

  const { refreshWorkers, doRescan, load } = createRescan(core, {
    ...ticketOps,
    ...unblockOps,
    ...prOps,
  });

  /** The pull requests the office can still read: a gone one is left out of every answer. */
  const seen = () => [...prs.values()].filter(visible);

  let timer: Cancel | undefined;
  let followTimer: Cancel | undefined;
  let running = false;

  const scheduleFollow = () => {
    followTimer = clock.setTimeout(() => {
      void state.followMerges().then(
        () => running && scheduleFollow(),
        (error: unknown) => {
          logger.warn("following merges failed", { error: String(error) });
          if (running) {
            scheduleFollow();
          }
        },
      );
    }, followInterval(opts));
  };

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
      const ctx: RefreshCtx = { fresh: [] };
      await locked(async () => {
        await handle(ctx, event);
        await refreshWorkers();
      });

      await deliver(ctx.fresh);
    },

    async rescan() {
      const ctx: RefreshCtx = { fresh: [] };
      try {
        await locked(() => doRescan(ctx));
      } finally {
        // What the rescan raised before it failed is already recorded and its state saved: deliver it, or it is lost.
        await deliver(ctx.fresh);
      }
    },

    async followMerges() {
      const ctx: RefreshCtx = { fresh: [] };
      try {
        await locked(() => followMerges(ctx));
      } finally {
        await deliver(ctx.fresh);
      }
    },

    refreshWorkers: () => locked(refreshWorkers),
    async refreshTicket(key, by) {
      const ctx: RefreshCtx = { fresh: [] };
      try {
        await locked(() => unblockOps.refreshAndUnblock(ctx, key, { by }));
      } finally {
        await deliver(ctx.fresh);
      }
    },

    async catchUp() {
      const ctx: RefreshCtx = { fresh: [] };
      await locked(async () => {
        for (const repo of repos) {
          for (const listed of await vcs.listPullRequests(repo, { state: "open" })) {
            const ref = { repo: listed.repo, number: listed.number };
            if (!prs.has(prSubject(ref))) {
              await refreshPr(ctx, ref, { baseline: true });
            }
          }
        }
      });

      await deliver(ctx.fresh);
    },

    async start() {
      if (running) {
        return;
      }

      running = true;
      schedule();
      scheduleFollow();
    },

    async stop() {
      running = false;
      timer?.();
      followTimer?.();
      timer = undefined;
      followTimer = undefined;
      await chain;
    },

    ticketForPr: (pr) => prs.get(prSubject(pr))?.ticket,
    ticketStatus: (t) => tickets.get(t)?.status,
    assignee: (t) => tickets.get(t)?.assignee,
    pullRequest(pr) {
      const rec = prs.get(prSubject(pr));
      return rec && visible(rec) ? toWorkflowPr(rec) : undefined;
    },
    pullRequests: (number) => seen().filter((p) => p.ref.number === number),
    repoPrs: (repo) => seen().filter((p) => sameRepo(p.ref.repo, repo)),
    pullRequestsOf: (t) =>
      seen()
        .filter((p) => p.ticket === t)
        .map(toWorkflowPr),
    prsOfTicket: (t) => seen().filter((p) => p.ticket === t),
    ticketForDraft: (draft) => locked(() => ticketOfDraft(draft)),
    handedBack: (t) => handedBack.has(t),
    ticket: (key) => tickets.get(key),
    doc: (id) => docs.get(id),
    docAuthor: (id) => docs.get(id)?.author,

    async linkDoc(doc) {
      const ctx: RefreshCtx = { fresh: [] };
      try {
        await locked(() => linkDoc(ctx, doc));
      } finally {
        await deliver(ctx.fresh);
      }
    },

    openDocs: (limit) =>
      [...docs.values()]
        .filter((d) => docOpen(core, d))
        .toSorted((a, b) => Date.parse(b.touchedAt) - Date.parse(a.touchedAt))
        .slice(0, limit),

    lastWorker: (t) => workers.get(t),
    blockedAgent: (t) => blockedAgent(tickets.get(t), work.get(t) ?? []),
    inRound: (t, person, at) => inRound(work.get(t) ?? [], person, at),
    requester: (t) => tickets.get(t)?.requester,
    hasLabel: (t, label) => tickets.get(t)?.labels.includes(label) ?? false,

    defaultBranch(repo) {
      const i = repos.findIndex((r) => sameRepo(r, repo));
      return (i >= 0 ? team.repos[i]?.default_branch : undefined) ?? "main";
    },

    stackedOn: (repo, branch) => stackedOn(core, repo, branch),

    personForRole(role) {
      const matches = team.people.filter((p) => p.role === role || p.extends?.includes(role));
      return matches.length === 1 ? matches[0]!.handle : undefined;
    },

    currentWork: (person) => currentWork(core, person),
    readyTickets: (person) => readyTickets(core, person),
  };

  await load();
  return state;
}

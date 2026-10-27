import type { PrRef, PrVerdict, PullRequest, RepoRef, WorkflowEvent } from "@outstaff/core";
import type { PrLive, PrOps, RefreshCtx, TicketOps, WorkstateCore } from "./core.types.js";
import { notFound, openPrs } from "./derive.js";
import { ticketCandidates } from "./infer.js";
import { personNode, prNode, relink, ROOT, ticketNode } from "./links.js";
import { ciFailure, keptLive, readLive, toPrRecord } from "./pr-record.js";
import type { PrRecord } from "./types.js";

const ACTOR = { kind: "automation", id: "workstate" } as const;

/** Pull request records: read from the code host, linked to tickets and stacks, and the events they raise. */
export function createPrs(core: WorkstateCore, ticketOps: TicketOps): PrOps {
  const { store, vcs, tracker, clock, logger, prs, vcsPeople, prSubject, ticketLinks } = core;
  const { ensureTicket } = ticketOps;
  const synthetic = async (
    ctx: RefreshCtx,
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

  /** The ticket a pull request links to: the first candidate by `ticketCandidates` (branch, title, closing keyword) that the tracker knows. */
  const ticketOfDraft = async (
    draft: { headRef: string; title: string; body?: string },
    prev?: PrRecord,
    repo?: RepoRef,
  ): Promise<string | undefined> => {
    // A draft names no repository, so every repository's patterns apply to it.
    const candidates = ticketCandidates(draft, ticketLinks(repo));
    const kept = candidates.find((c) => c.key === prev?.ticket);
    if (kept) {
      return kept.key;
    }

    for (const { key, source } of candidates) {
      if (!tracker || (await ensureTicket(key))) {
        logger.info("pull request linked to ticket", {
          headRef: draft.headRef,
          ticket: key,
          source,
        });

        return key;
      }
    }

    return undefined;
  };

  const inferTicket = (pr: PullRequest, prev?: PrRecord) =>
    ticketOfDraft({ headRef: pr.head.ref, title: pr.title, body: pr.body }, prev, pr.repo);

  const restack = async (repo: RepoRef) => {
    const open = openPrs(core, repo);
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
        store,
        prNode(key),
        "stacked_on",
        rec.stackedOn ? prNode(rec.stackedOn) : undefined,
        next ? prNode(next) : undefined,
      );
    }
  };

  const fetchPr = async (ref: PrRef, wait = false): Promise<PullRequest | undefined> => {
    try {
      return await vcs.getPullRequest(ref.repo, ref.number, { waitForMergeable: wait });
    } catch (error) {
      if (notFound(error)) {
        logger.warn("pull request not found", { pr: prSubject(ref) });
        return undefined;
      }

      throw error;
    }
  };

  /** The events a change of an open pull request raises: it started to conflict, or its CI started to fail. */
  const raiseEvents = async (
    ctx: RefreshCtx,
    rec: PrRecord,
    prev: PrRecord | undefined,
    links: PrLive["links"],
  ) => {
    if (rec.mergeable === "conflicting" && prev?.mergeable !== "conflicting") {
      await synthetic(ctx, "pr.conflicted", rec, { base: rec.baseRef });
    }

    if (rec.ci === "failure" && prev?.ci !== "failure") {
      await synthetic(ctx, "pr.ci_failed", rec, ciFailure(rec.checks, links));
    }
  };

  const save = async (key: string, rec: PrRecord, prev: PrRecord | undefined) => {
    prs.set(key, rec);
    await store.upsertSubject("pr", key, rec);
    await store.link(ROOT, prNode(key), "tracks");
    await relink(
      store,
      prNode(key),
      "implements",
      prev?.ticket ? ticketNode(prev.ticket) : undefined,
      rec.ticket ? ticketNode(rec.ticket) : undefined,
    );

    await relink(
      store,
      prNode(key),
      "authored_by",
      prev?.author.person ? personNode(prev.author.person) : undefined,
      rec.author.person ? personNode(rec.author.person) : undefined,
    );

    await restack(rec.ref.repo);
  };

  const refreshPr = async (
    ctx: RefreshCtx,
    ref: PrRef,
    o: { baseline?: boolean; wait?: boolean; review?: string; verdict?: PrVerdict } = {},
  ): Promise<void> => {
    const known = prs.get(prSubject(ref));
    const pr = await fetchPr(ref, o.wait);
    if (!pr) {
      return;
    }

    const key = prSubject({ repo: pr.repo, number: pr.number });
    const prev = prs.get(key) ?? known;
    const open = pr.state === "open";
    const live = open ? await readLive(vcs, pr) : keptLive(prev);
    const person = vcsPeople.get(pr.author.login.toLowerCase());
    const ticket = await inferTicket(pr, prev);
    const rec = toPrRecord(
      pr,
      prev,
      { ...live, person, ticket, review: o.review, verdict: o.verdict },
      clock.now().toISOString(),
    );

    // A pull request seen for the first time during a rescan sets the baseline instead of raising events.
    if (open && (prev || !o.baseline)) {
      await raiseEvents(ctx, rec, prev, live.links);
    }

    await save(key, rec, prev);
  };

  return { refreshPr, ticketOfDraft };
}

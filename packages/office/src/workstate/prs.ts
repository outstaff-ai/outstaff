import type { PrRef, PrVerdict, PullRequest, RepoRef, WorkflowEvent } from "@outstaff/core";
import type { PrOps, RefreshCtx, TicketOps, WorkstateCore } from "./core.types.js";
import { ciOf, notFound, openPrs } from "./derive.js";
import { ticketCandidates } from "./infer.js";
import { personNode, prNode, relink, ROOT, ticketNode } from "./links.js";
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

  const refreshPr = async (
    ctx: RefreshCtx,
    ref: PrRef,
    o: { baseline?: boolean; wait?: boolean; review?: string; verdict?: PrVerdict } = {},
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
    let links = new Map<string, { url: string; summary?: string }>();
    let unresolved = prev?.unresolvedThreads ?? 0;
    if (open) {
      const [found, threads] = await Promise.all([
        vcs.checks(pr.repo, pr.head.sha),
        vcs.reviewThreads(pr.repo, pr.number),
      ]);

      checks = found.map((c) => ({ name: c.name, status: c.status }));
      links = new Map(
        found.map((c) => [c.name, { url: c.url, ...(c.summary ? { summary: c.summary } : {}) }]),
      );

      unresolved = threads.filter((t) => !t.resolved).length;
    }

    const person = vcsPeople.get(pr.author.login.toLowerCase());
    const review = o.review ?? prev?.review;
    const verdicts = o.verdict
      ? [...(prev?.verdicts ?? []).filter((v) => v.actor !== o.verdict!.actor), o.verdict]
      : prev?.verdicts;

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
      ...(verdicts?.length ? { verdicts } : {}),
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
        const failed = checks.filter((c) => c.status === "failure");
        await synthetic(ctx, "pr.ci_failed", rec, {
          failing: failed.map((c) => c.name),
          checks: failed.map((c) => ({
            name: c.name,
            ...links.get(c.name),
          })),
        });
      }
    }

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
      person ? personNode(person) : undefined,
    );

    await restack(rec.ref.repo);
  };

  return { refreshPr, ticketOfDraft };
}

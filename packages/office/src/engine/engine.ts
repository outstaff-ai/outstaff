import {
  describeEffect,
  blockedNotify,
  explainWorkflow,
  PortError,
  policyOn,
  PRESET_MOVES_TICKETS,
  resolveWorkflow,
  type Effect,
  type EffectTarget,
  type Tracker,
  type WorkflowEvent,
} from "@outstaff/core";
import { ATTACH_REASSIGN_SUBJECT, CHAT_ORIGIN_SUBJECT, readOrigin } from "#/chat/origin.js";
import {
  addFeedback,
  awaitsReview,
  feedbackOf,
  FOLLOW_UP_SUBJECT,
  undeliveredFeedback,
} from "./feedback.js";
import { clip, prLabel, subjectLabel } from "#/log.js";
import { PRIORITY, priorityFor } from "#/scheduler/index.js";
import type { WorkItem, WorkItemTrigger } from "#/store/index.js";
import type { Feedback } from "@outstaff/protocol";
import type { EffectOutcome, Engine, EngineMeta, EngineOptions } from "./types.js";

const PLAN = "engine";
const LIVE = new Set(["queued", "active"]);
const PRIORITY_SHIFT = 5;

/** The kinds of work on a ticket; one round of them covers a schedule for another on the same ticket. */
const TICKET_WORK = new Set(["assigned", "ticket_comment", "doc_feedback"]);

/** Kinds that only answer something on a ticket; starting one leaves the ticket where it is. */
const ANSWERS = new Set(["asked", "doc_feedback", "unblock"]);

/**
 * Where a ticket starts being worked on from. Not blocked: a retry that is still blocked at its end leaves the ticket
 * blocked, and the agent that gets past it says so by moving the ticket.
 */
const STARTS_FROM = new Set(["backlog", "ready", "review"]);
const TRANSIENT = new Set(["rate_limited", "unavailable"]);

interface Plan {
  effects: Effect[];
  outcomes: (EffectOutcome | null)[];

  /** Blocked items this event asks to run again; kept so a redelivery retries the same ones. */
  retry?: { id: string; person: string }[];
  retried?: true;
}

/** The signal a trusted human's event is, when it can bring a blocked item back. */
function retrySignal(event: WorkflowEvent): string | undefined {
  switch (event.type) {
    case "ticket.moved": {
      const to = event.data["to"];
      return to === "ready" || to === "active" ? "ticket moved" : undefined;
    }

    case "ticket.assigned":
      return "ticket assigned";
    case "pr.review_submitted":
      return "PR review";
    case "pr.comment":
      return "PR comment";
    default:
      return undefined;
  }
}

/** What an applied effect did, in the past tense, for the log. */
function past(e: Effect): string {
  switch (e.type) {
    case "schedule":
      return `scheduled ${e.kind} for ${e.person}${e.pr ? ` on ${prLabel(e.pr)}` : e.ticket ? ` on ${e.ticket}` : e.doc ? ` on doc ${e.doc}` : ""}`;
    case "move":
      return `moved ${e.ticket} to ${e.to}`;
    case "assign":
      return e.to ? `assigned ${e.ticket} to ${e.to.id}` : `unassigned ${e.ticket}`;
    case "comment":
      return `commented on ${"ticket" in e.on ? e.on.ticket : prLabel(e.on.pr)}`;
  }
}

/** Thrown inside an effect to record it as skipped instead of applied. */
class Skip extends Error {}

/** Thrown inside a schedule effect that joined an item already queued or running: applied, but nothing new queued. */
class Attached extends Error {}

const sameSubject = (a: WorkItem["subject"], b: { type: string; ref: string } | undefined) =>
  !!a && !!b && a.type === b.type && a.ref === b.ref;

export function createEngine(opts: EngineOptions): Engine {
  const { store, workState, scheduler, team, clock, logger } = opts;
  const now = () => clock.now().toISOString();
  const tracker: Tracker | undefined = opts.ports?.tracker;
  const workflow = opts.workflow ?? resolveWorkflow(team.workflow, team.humans, team.policies);
  // One event at a time: effects read the work queue and must not race each other.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const trackerId = (target: EffectTarget): Promise<string> | string => {
    if (target.kind === "agent") {
      return team.people.find((p) => p.handle === target.id)?.identities?.tracker ?? target.id;
    }

    const wanted =
      team.humans?.find((h) => h.identities.tracker === target.id)?.identities.tracker ?? target.id;

    // Identities may be usernames or names; the tracker wants its member id.
    return tracker!.members().then((all) => {
      const lower = wanted.toLowerCase();
      const hit =
        all.find((m) => m.id === wanted || m.username === wanted) ??
        all.find((m) => m.name.toLowerCase() === lower);

      return hit?.id ?? wanted;
    });
  };

  const triggerOf = (event: WorkflowEvent): WorkItemTrigger => {
    if (event.type === "schedule.cron") {
      return "schedule";
    }

    return event.actor.kind;
  };

  const priorityNumber = (trigger: WorkItemTrigger, kind: string, p: "low" | "normal" | "high") => {
    const base = priorityFor(trigger, kind);
    if (p === "normal") {
      return base;
    }

    return p === "high"
      ? Math.max(PRIORITY.humanChat + 1, base - PRIORITY_SHIFT)
      : base + PRIORITY_SHIFT;
  };

  const ticketTitle = async (key: string) =>
    ((await store.getSubject("ticket", key))?.data as { title?: string } | undefined)?.title;

  // The tracker's own echo of our change arrives later; the state must not wait for it, or the next event
  // would be judged against a ticket we already moved.
  const sync = (
    ticket: string,
    type: "ticket.moved" | "ticket.assigned",
    data: Record<string, unknown>,
  ) =>
    workState.apply(
      { type, subject: { ticket }, actor: { kind: "automation", id: "engine" }, data },
      { source: "workstate", externalId: `engine:${type}:${ticket}:${now()}`, trusted: true },
    );

  const humanize = (kind: string) => kind.replaceAll(/[_-]/g, " ");

  /**
   * What an `unblock` round carries about the blocked hand-back: the agent, and its last comment on the ticket (else
   * the summary it handed back), as data. The ticket itself is the round's subject.
   */
  const blocked = async (event: WorkflowEvent, ticket: string | undefined): Promise<Feedback> => {
    const agent = event.actor.id;
    const mine = team.people.find((p) => p.handle === agent)?.identities?.tracker;
    let body: string | undefined;
    let url: string | undefined;
    let at: string | undefined;
    if (tracker && ticket) {
      try {
        const comments = await tracker.listComments(ticket);
        const byAgent = comments.filter(
          (c) =>
            mine !== undefined && [c.author.id, c.author.username, c.author.name].includes(mine),
        );

        const last = (byAgent.length > 0 ? byAgent : comments)
          .toSorted((a, b) => a.at.localeCompare(b.at))
          .at(-1);

        if (last) {
          ({ body, url, at } = last);
        }
      } catch (error) {
        logger.warn("could not read the last comment of a blocked ticket", {
          ticket,
          error: String(error),
        });
      }
    }

    if (body === undefined) {
      const itemId = event.data["workItem"];
      const journal = typeof itemId === "string" ? await store.readJournal(itemId) : [];
      body = journal.filter((j) => j.author === agent).at(-1)?.text ?? "";
    }

    return {
      actor: agent,
      kind: "blocked",
      body,
      ...(url ? { url } : {}),
      ...(at ? { at } : {}),
    };
  };

  /** The ticket an item is about, directly or through its pull request. */
  const ticketOfItem = async (item: WorkItem): Promise<string | undefined> => {
    if (item.subject?.type === "ticket") {
      return item.subject.ref;
    }

    return item.subject?.type === "pr"
      ? ((await store.getSubject("pr", item.subject.ref))?.data as { ticket?: string } | undefined)
          ?.ticket
      : undefined;
  };

  /** The blocked items a trusted human's event brings back: the ones on its ticket or pull request. */
  const blockedFor = async (event: WorkflowEvent): Promise<WorkItem[]> => {
    if (
      !policyOn(team.policies, "retry.on_signal") ||
      event.actor.kind !== "human" ||
      retrySignal(event) === undefined
    ) {
      return [];
    }

    const pr = event.subject.pr;
    const ticket = event.subject.ticket ?? (pr ? workState.ticketForPr(pr) : undefined);
    const blocked = await store.listItems({ status: "blocked" });
    const prKey = pr ? workState.prSubject(pr) : undefined;
    const author = pr ? workState.pullRequest(pr)?.author.person : undefined;
    const assignee =
      event.type === "ticket.assigned" && ticket ? workState.assignee(ticket) : undefined;

    const hits: WorkItem[] = [];
    for (const item of blocked) {
      // A PM waiting for a human is not the work that was blocked: the agent's own item is the one to retry.
      if (item.kind === "unblock") {
        continue;
      }

      const onPr = prKey !== undefined && item.subject?.type === "pr" && item.subject.ref === prKey;
      const onTicket = ticket !== undefined && (await ticketOfItem(item)) === ticket;
      if (!onPr && !onTicket) {
        continue;
      }

      // Only the person the signal is about: the owner of the assignment, the author of the pull request.
      if (
        event.type === "ticket.assigned" &&
        !(assignee?.kind === "agent" && assignee.id === item.person)
      ) {
        continue;
      }

      if (pr && author !== undefined && item.person !== author) {
        continue;
      }

      hits.push(item);
    }

    return hits;
  };

  const retryNote = async (item: WorkItem, event: WorkflowEvent) => {
    const ticket = (await ticketOfItem(item)) ?? event.subject.ticket;
    if (!tracker || !ticket) {
      // Pull requests have no comment port yet, so without a ticket the journal and the log are the record.
      return;
    }

    try {
      await tracker.comment(ticket, `Retrying ${item.subject?.ref ?? ticket} on request`);
    } catch (error) {
      logger.warn("could not post the retry note", { item: item.id, error: String(error) });
    }
  };

  const retryBlocked = async (plan: Plan, event: WorkflowEvent) => {
    const signal = retrySignal(event);
    for (const { id } of plan.retry ?? []) {
      const item = await scheduler.retry(id, { by: event.actor.id, signal: signal! });
      if (!item) {
        continue;
      }

      const feedback = event.data["body"];
      if (typeof feedback === "string" && feedback.trim() !== "") {
        await store.appendJournal(id, event.actor.id, `${signal}: ${feedback.trim()}`);
      }

      await retryNote(item, event);
    }
  };

  const schedule = async (
    e: Extract<Effect, { type: "schedule" }>,
    event: WorkflowEvent,
    plan: Plan,
  ): Promise<string> => {
    if (!team.people.some((p) => p.handle === e.person)) {
      throw new Skip(`${e.person} is not a person on the team`);
    }

    // What a person did themselves never starts work for them, for example assigning a ticket to oneself.
    // A hand-back is the exception: the merge that follows an agent's own round on an approval is for that agent.
    if (
      event.actor.kind === "agent" &&
      event.actor.id === e.person &&
      event.type !== "agent.handed_back"
    ) {
      throw new Skip(`${e.person} caused the event themselves`);
    }

    // A blocked PM has nobody to route it to: the PM tells the requester itself, so no round is scheduled.
    if (e.kind === "unblock" && event.actor.kind === "agent" && event.actor.id === e.person) {
      throw new Skip(`${e.person} is the blocked agent itself`);
    }

    // The blocked item that was just retried carries the new feedback; a second item would run beside it.
    const retried = plan.retry?.find((r) => r.person === e.person);
    if (retried) {
      throw new Skip(`work item ${retried.id} was retried on request instead`);
    }

    const subject = e.pr
      ? { type: "pr", ref: workState.prSubject(e.pr) }
      : e.ticket
        ? { type: "ticket", ref: e.ticket }
        : e.doc
          ? { type: "doc", ref: e.doc }
          : undefined;

    const mine = await store.listItems({ person: e.person });
    if (subject) {
      // One round per ticket: ticket work joins the round another ticket-work kind already has on that ticket.
      const dup = mine.find(
        (i) =>
          LIVE.has(i.status) &&
          sameSubject(i.subject, subject) &&
          (i.kind === e.kind ||
            (subject.type === "ticket" && TICKET_WORK.has(i.kind) && TICKET_WORK.has(e.kind))),
      );

      if (dup) {
        // Feedback for a round that is queued or running is attached to it instead of being lost: a queued item
        // offers it with the rest, and for a running one the follow-up round after the hand-back picks it up.
        const feedback = feedbackOf(event);
        if (feedback) {
          await addFeedback(store, dup.id, feedback);
          throw new Attached(
            dup.status === "queued"
              ? `attached to work item ${dup.id} (${dup.kind}, queued)`
              : `attached to work item ${dup.id} (${dup.kind}, running; a follow-up round starts after its hand-back)`,
          );
        }

        throw new Skip(`work item ${dup.id} (${dup.kind}) is already ${dup.status}`);
      }
    }

    const ticket = e.ticket ?? (e.pr ? workState.ticketForPr(e.pr) : undefined);
    const prTitle = e.pr ? workState.pullRequest(e.pr)?.title : undefined;
    // The ticket key goes in only when the title does not have it already.
    const mentions = (text: string | undefined, key: string) =>
      text?.toLowerCase().includes(key.toLowerCase()) ?? false;

    const ticketText = e.ticket ? await ticketTitle(e.ticket) : undefined;
    const subjectText = e.pr
      ? `PR #${e.pr.number}${prTitle ? ` ${prTitle}` : ""}${ticket && !mentions(prTitle, ticket) ? ` (${ticket})` : ""}`
      : e.ticket
        ? mentions(ticketText, e.ticket)
          ? ticketText!
          : `${e.ticket} ${ticketText ?? ""}`.trim()
        : e.doc
          ? (workState.doc(e.doc)?.title ?? `document ${e.doc}`)
          : "";

    // The earlier work on the same ticket or pull request, so the history reads as one thread.
    const related = (
      await Promise.all(
        mine.map(async (i) => {
          if (!i.subject) {
            return undefined;
          }

          const itemTicket =
            i.subject.type === "ticket"
              ? i.subject.ref
              : (
                  (await store.getSubject("pr", i.subject.ref))?.data as
                    | { ticket?: string }
                    | undefined
                )?.ticket;

          return sameSubject(i.subject, subject) || (ticket && itemTicket === ticket)
            ? i
            : undefined;
        }),
      )
    )
      .filter((i) => i !== undefined)
      .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];

    const feedback =
      feedbackOf(event) ?? (e.kind === "unblock" ? await blocked(event, ticket) : undefined);

    const trigger = triggerOf(event);
    const item = await scheduler.enqueue({
      person: e.person,
      kind: e.kind,
      title: subjectText ? `${humanize(e.kind)}: ${subjectText}` : humanize(e.kind),
      trigger,
      priority: priorityNumber(trigger, e.kind, e.priority),
      ...(related ? { parentId: related.id } : {}),
      ...(subject ? { subject } : {}),
    });

    if (feedback) {
      await addFeedback(store, item.id, feedback);
    }

    return `queued work item ${item.id} for ${e.person}`;
  };

  const apply = async (e: Effect, event: WorkflowEvent, plan: Plan): Promise<string> => {
    switch (e.type) {
      case "schedule":
        return schedule(e, event, plan);
      case "move":
        if (!tracker) {
          throw new Skip("no tracker is configured");
        }

        await tracker.transition(e.ticket, e.to);
        await sync(e.ticket, "ticket.moved", { to: e.to });
        return `moved ${e.ticket} to ${e.to}`;
      case "assign": {
        if (!tracker) {
          throw new Skip("no tracker is configured");
        }

        await tracker.assign(e.ticket, e.to ? await trackerId(e.to) : null);
        await sync(e.ticket, "ticket.assigned", {});
        return e.to ? `assigned ${e.ticket} to ${e.to.id}` : `unassigned ${e.ticket}`;
      }

      case "comment":
        if (!("ticket" in e.on)) {
          throw new Skip("comments on pull requests are not supported by the ports yet");
        }

        if (!tracker) {
          throw new Skip("no tracker is configured");
        }

        await tracker.comment(e.on.ticket, e.body);
        return `commented on ${e.on.ticket}`;
    }
  };

  const run = async (event: WorkflowEvent, meta: EngineMeta): Promise<EffectOutcome[]> => {
    if (awaitsReview(event)) {
      logger.info(
        `engine: ${event.type} on ${subjectLabel(event.subject)} waits for its review to be submitted`,
        { type: event.type, id: `${meta.source}:${meta.externalId}` },
      );

      return [];
    }

    if (meta.trusted === false || event.data["untrusted"] === true) {
      logger.info("engine ignored an untrusted event", { type: event.type, id: meta.externalId });
      return [];
    }

    const ref = `${meta.source}:${meta.externalId}`;
    const saved = (await store.getSubject(PLAN, ref))?.data as Plan | undefined;
    // On redelivery the stored plan wins: the state has moved on, and re-evaluating could shift the indexes.
    const explanation = saved
      ? undefined
      : explainWorkflow(event, workState, workflow.rules, workflow.options);

    const plan: Plan = saved ?? {
      effects: explanation!.effects,
      outcomes: [],
      retry: (await blockedFor(event)).map((i) => ({ id: i.id, person: i.person })),
    };

    const subject = subjectLabel(event.subject);
    const ruleOf = new Map<string, string[]>();
    if (explanation) {
      const matched = explanation.rules.filter((r) => r.matched);
      for (const r of matched) {
        for (const effect of r.effects) {
          const key = JSON.stringify(effect);
          ruleOf.set(key, [...(ruleOf.get(key) ?? []), r.id]);
        }

        // A skipped action (for example a ticket with no requester) is worth a warning.
        logger[r.skipped.length > 0 ? "warn" : "info"](
          `engine: rule ${r.id} matched ${event.type} on ${subject}: ${r.effects.map(describeEffect).join("; ") || "no effects"}`,
          {
            rule: r.id,
            type: event.type,
            subject,
            effects: r.effects.map(describeEffect),
            ...(r.skipped.length > 0 ? { skipped: r.skipped } : {}),
          },
        );
      }

      if (matched.length === 0) {
        logger.info(`engine: no rule matched ${event.type} on ${subject}`, {
          type: event.type,
          subject,
        });
      }
    }

    if (!saved) {
      plan.outcomes = plan.effects.map(() => null);
      await store.upsertSubject(PLAN, ref, plan);
    }

    if (!plan.retried) {
      await retryBlocked(plan, event);
      plan.retried = true;
      await store.upsertSubject(PLAN, ref, plan);
    }

    const results: EffectOutcome[] = [];
    for (const [i, effect] of plan.effects.entries()) {
      const done = plan.outcomes[i];
      if (done) {
        results.push(done);
        continue;
      }

      let outcome: EffectOutcome;
      let attached = false;
      try {
        outcome = { effect, status: "applied", note: await apply(effect, event, plan), at: now() };
      } catch (error) {
        if (error instanceof Attached) {
          outcome = { effect, status: "applied", note: error.message, at: now() };
          attached = true;
        } else if (error instanceof Skip) {
          outcome = { effect, status: "skipped", note: error.message, at: now() };
        } else if (error instanceof PortError && !TRANSIENT.has(error.code)) {
          outcome = {
            effect,
            status: "failed",
            note: `${error.code}: ${error.message}`,
            at: now(),
          };
        } else {
          // Transient: the event is redelivered and continues from the recorded outcomes.
          throw error;
        }
      }

      if (outcome.status === "applied") {
        const rules = ruleOf.get(JSON.stringify(effect));
        logger.info(`engine: ${attached ? outcome.note : past(effect)}`, {
          effect: effect.type,
          subject,
          ...(rules ? { rules } : {}),
          id: ref,
        });
      } else {
        logger.warn("effect not applied", {
          type: effect.type,
          note: clip(outcome.note, 200),
          id: ref,
        });
      }

      plan.outcomes[i] = outcome;
      await store.upsertSubject(PLAN, ref, plan);
      results.push(outcome);
    }

    return results;
  };

  const followUp = async (itemId: string): Promise<void> => {
    if (!policyOn(team.policies, "feedback.follow_up_round")) {
      return;
    }

    if ((await store.getSubject(FOLLOW_UP_SUBJECT, itemId)) !== undefined) {
      return;
    }

    const late = await undeliveredFeedback(store, itemId);
    const item = await store.getItem(itemId);
    if (!item || late.length === 0) {
      return;
    }

    // Anything the hand-back could not have covered, because it arrived after the offer, gets a round of its own.
    // A request from chat that reached the item late is answered in the same threads.
    const origin = await readOrigin(store, itemId);
    const next = await scheduler.enqueue({
      person: item.person,
      kind: item.kind,
      title: item.title,
      trigger: item.trigger,
      priority: item.priority,
      parentId: item.id,
      ...(item.subject ? { subject: item.subject } : {}),
      // Stored before the item can be offered: an offer without its feedback or origin would never be repeated.
      init: async (created) => {
        for (const feedback of late) {
          await addFeedback(store, created.id, feedback);
        }

        if (origin) {
          await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, {
            channel: origin.channel,
            thread: origin.thread,
            requester: origin.requester,
            direct: origin.direct,
            participant: origin.participant,
            awaitingPlacement: false,
            claimed: [],
            ...(origin.also ? { also: origin.also } : {}),
          });
        }
      },
    });

    await store.upsertSubject(FOLLOW_UP_SUBJECT, itemId, { itemId: next.id });
    logger.info(
      `engine: queued follow-up work item ${next.id} for ${item.person}: ${late.length} new feedback after ${item.id} was offered`,
      { person: item.person, item: next.id, after: item.id },
    );
  };

  /**
   * A work item about a ticket moves it to active when it starts: the office's mechanics, not the agent's duty. Work on
   * an open pull request reopens its ticket when that was closed early (a merge into a stack's feature branch).
   */
  const moveOnStart = async (item: WorkItem): Promise<void> => {
    if (
      !tracker ||
      ANSWERS.has(item.kind) ||
      item.kind === "merge" ||
      !policyOn(team.policies, "tickets.start_moves_active") ||
      !PRESET_MOVES_TICKETS[team.workflow?.preset ?? "kanban"]
    ) {
      return;
    }

    let key: string | undefined;
    let from = STARTS_FROM;
    if (item.subject?.type === "ticket") {
      key = item.subject.ref;
    } else if (item.subject?.type === "pr") {
      const pr = (await store.getSubject("pr", item.subject.ref))?.data as
        | { ticket?: string; state?: string }
        | undefined;

      if (pr?.state === "open") {
        key = pr.ticket;
        from = new Set(["done"]);
      }
    }

    const status = key ? workState.ticket(key)?.status : undefined;
    if (!key || !status || !from.has(status)) {
      return;
    }

    try {
      await tracker.transition(key, "active");
      await sync(key, "ticket.moved", { to: "active" });
      logger.info(`engine: moved ${key} to active, ${item.kind} work item ${item.id} started`, {
        ticket: key,
        item: item.id,
      });
    } catch (error) {
      logger.warn("could not move the ticket to active when its work started", {
        ticket: key,
        error: String(error),
      });
    }
  };

  const started = async (itemId: string): Promise<void> => {
    const item = await store.getItem(itemId);
    if (item) {
      await moveOnStart(item);
    }

    const key = item ? await ticketOfItem(item) : undefined;
    if (!item || !key || !tracker) {
      return;
    }

    const ref = `${item.person}:${key}`;
    const mark = (await store.getSubject(ATTACH_REASSIGN_SUBJECT, ref))?.data as
      | { pending?: boolean }
      | undefined;

    if (!mark?.pending) {
      return;
    }

    try {
      const assignee = workState.ticket(key)?.assignee;
      if (assignee?.kind !== "agent" || assignee.id !== item.person) {
        await tracker.assign(key, await trackerId({ kind: "agent", id: item.person }));
        await sync(key, "ticket.assigned", {});
        logger.info("assigned the attached ticket back to the agent", {
          ticket: key,
          person: item.person,
        });
      }

      await store.upsertSubject(ATTACH_REASSIGN_SUBJECT, ref, { pending: false });
    } catch (error) {
      logger.warn("could not assign the attached ticket to the agent", {
        ticket: key,
        error: String(error),
      });
    }
  };

  const unblock = async (item: WorkItem, reason: string): Promise<boolean> => {
    const pm = team.people.find((p) => p.role === "pm")?.handle;
    const ticket = await ticketOfItem(item);
    if (
      !pm ||
      pm === item.person ||
      !ticket ||
      blockedNotify(team) !== "pm" ||
      item.kind === "unblock"
    ) {
      return false;
    }

    const feedback: Feedback = { actor: item.person, kind: "blocked", body: reason, at: now() };
    const subject = { type: "ticket", ref: ticket };
    const live = (await store.listItems({ person: pm })).find(
      (i) => LIVE.has(i.status) && i.kind === "unblock" && sameSubject(i.subject, subject),
    );

    if (live) {
      await addFeedback(store, live.id, feedback);
      return true;
    }

    const created = await scheduler.enqueue({
      person: pm,
      kind: "unblock",
      title: `Unblock: ${ticket}`,
      trigger: "automation",
      priority: priorityNumber("automation", "unblock", "high"),
      parentId: item.id,
      subject,
    });

    await addFeedback(store, created.id, feedback);
    logger.info(`engine: queued unblock for ${pm} on ${ticket}: ${item.id} was blocked`, {
      person: pm,
      item: created.id,
    });

    return true;
  };

  /**
   * An item finished the work on a ticket that is not blocked any more: the same person's earlier blocked items on
   * that ticket are closed, because nothing is left to retry.
   */
  const settled = async (item: WorkItem): Promise<void> => {
    const ticket = await ticketOfItem(item);
    if (
      !ticket ||
      item.status !== "done" ||
      ANSWERS.has(item.kind) ||
      workState.ticket(ticket)?.status === "blocked"
    ) {
      return;
    }

    for (const old of await store.listItems({ status: "blocked" })) {
      if (
        old.id === item.id ||
        old.person !== item.person ||
        old.kind === "unblock" ||
        (await ticketOfItem(old)) !== ticket
      ) {
        continue;
      }

      await store.updateItem(old.id, { status: "canceled" });
      await store.appendJournal(
        old.id,
        "office",
        `Closed: work item ${item.id} finished the work on ${ticket}.`,
      );

      logger.info(`engine: closed blocked work item ${old.id}, ${item.id} finished ${ticket}`, {
        item: old.id,
        by: item.id,
        ticket,
      });
    }
  };

  return {
    settled: (item) => locked(() => settled(item)),
    unblock: (item, reason) => locked(() => unblock(item, reason)),
    started: (itemId) => locked(() => started(itemId)),
    handle: (event, meta) => locked(() => run(event, meta)),
    followUp: (itemId) => locked(() => followUp(itemId)),
  };
}

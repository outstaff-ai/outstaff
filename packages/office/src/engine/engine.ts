import {
  describeEffect,
  explainWorkflow,
  PortError,
  resolveWorkflow,
  type Chat,
  type Effect,
  type EffectTarget,
  type Tracker,
  type WorkflowEvent,
} from "@outstaff/core";
import { feedbackOf, FEEDBACK_SUBJECT } from "./feedback.js";
import { clip, prLabel, subjectLabel } from "../log.js";
import { PRIORITY, priorityFor } from "../scheduler/index.js";
import type { WorkItem, WorkItemTrigger } from "../store/index.js";
import type { EffectOutcome, Engine, EngineMeta, EngineOptions } from "./types.js";

const PLAN = "engine";
const LIVE = new Set(["queued", "active"]);
const PRIORITY_SHIFT = 5;
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
      return `scheduled ${e.kind} for ${e.person}${e.pr ? ` on ${prLabel(e.pr)}` : e.ticket ? ` on ${e.ticket}` : ""}`;
    case "move":
      return `moved ${e.ticket} to ${e.to}`;
    case "assign":
      return e.to ? `assigned ${e.ticket} to ${e.to.id}` : `unassigned ${e.ticket}`;
    case "comment":
      return `commented on ${"ticket" in e.on ? e.on.ticket : prLabel(e.on.pr)}`;
    case "notify":
      return `notified ${e.to.kind}${e.to.id ? ` ${e.to.id}` : ""}`;
  }
}

/** Thrown inside an effect to record it as skipped instead of applied. */
class Skip extends Error {}

const sameSubject = (a: WorkItem["subject"], b: { type: string; ref: string } | undefined) =>
  !!a && !!b && a.type === b.type && a.ref === b.ref;

export function createEngine(opts: EngineOptions): Engine {
  const { store, workState, scheduler, team, clock, logger } = opts;
  const now = () => clock.now().toISOString();
  const tracker: Tracker | undefined = opts.ports?.tracker;
  const chat: Chat | undefined = opts.ports?.chat;
  const workflow = opts.workflow ?? resolveWorkflow(team.workflow);
  const channel =
    opts.channel ??
    (typeof team.integrations.chat["channel"] === "string"
      ? team.integrations.chat["channel"]
      : undefined);

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

  const chatId = (to: { kind: "human" | "agent"; id?: string }): string | undefined => {
    if (to.kind === "agent") {
      return team.people.find((p) => p.handle === to.id)?.identities?.chat;
    }

    const human = team.humans?.find(
      (h) => h.identities.tracker === to.id || h.identities.vcs === to.id,
    );

    return human?.identities.chat;
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
    if (event.actor.kind !== "human" || retrySignal(event) === undefined) {
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
    if (event.actor.kind === "agent" && event.actor.id === e.person) {
      throw new Skip(`${e.person} caused the event themselves`);
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
        : undefined;

    const mine = await store.listItems({ person: e.person });
    if (subject) {
      const dup = mine.find(
        (i) =>
          LIVE.has(i.status) &&
          // A chat request is already working on the ticket it filed.
          (i.kind === e.kind || i.kind === "chat") &&
          sameSubject(i.subject, subject),
      );

      if (dup) {
        throw new Skip(`work item ${dup.id} (${dup.kind}) is already ${dup.status}`);
      }
    }

    const ticket = e.ticket ?? (e.pr ? workState.ticketForPr(e.pr) : undefined);
    const prTitle = e.pr ? workState.pullRequest(e.pr)?.title : undefined;
    const subjectText = e.pr
      ? `PR #${e.pr.number}${prTitle ? ` ${prTitle}` : ""}${ticket ? ` (${ticket})` : ""}`
      : e.ticket
        ? `${e.ticket} ${(await ticketTitle(e.ticket)) ?? ""}`.trim()
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

    const feedback = feedbackOf(event);
    if (feedback) {
      await store.upsertSubject(FEEDBACK_SUBJECT, item.id, feedback);
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
      case "notify": {
        if (!chat) {
          throw new Skip("no chat is configured");
        }

        let target: string | undefined;
        if (e.to.kind === "channel") {
          target = e.to.id ?? channel;
        } else {
          const user = chatId({ kind: e.to.kind, ...(e.to.id ? { id: e.to.id } : {}) });
          target = user ? await chat.openDirect(user) : undefined;
        }

        if (!target) {
          throw new Skip(`no chat destination for ${e.to.kind}${e.to.id ? ` ${e.to.id}` : ""}`);
        }

        await chat.post(target, e.body);
        return `posted to ${target}`;
      }
    }
  };

  const run = async (event: WorkflowEvent, meta: EngineMeta): Promise<EffectOutcome[]> => {
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

        logger.info(
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
      try {
        outcome = { effect, status: "applied", note: await apply(effect, event, plan), at: now() };
      } catch (error) {
        if (error instanceof Skip) {
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
        logger.info(`engine: ${past(effect)}`, {
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

  return { handle: (event, meta) => locked(() => run(event, meta)) };
}

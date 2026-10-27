import { policyOn, type WorkflowEvent } from "@outstaff/core";
import type { IdlePull, IdlePullOptions } from "./office-idle.types.js";
import { nextReadyTicket } from "./pipeline/idle.js";
import type { PipelineEvent } from "./pipeline/events.types.js";
import { CHAT_KIND, priorityFor } from "./scheduler/index.js";

const KIND = "assigned";
const TRIGGER = "automation";
const BUSY = new Set(["queued", "active"]);

/** Ticket changes that can give an agent a ready ticket. */
const TICKET_CHANGES = new Set(["ticket.created", "ticket.assigned", "ticket.moved"]);

/**
 * The idle pull (`policies.pull_ready`): an agent with no work item queued or running starts its next ready ticket.
 * Checked when a ticket change gives the agent a ready ticket, after a hand-back, on the scheduler's tick and when the
 * agent connects. The office raises `agent.idle` only when there is a ready ticket to start, so an idle team leaves no
 * trace every tick. With the pipeline off the pull is the scheduler's own; in shadow mode it is traced first; live,
 * the `idle_pulls_next` policy decides it.
 */
export function createIdlePull(opts: IdlePullOptions): IdlePull {
  const { team, store, workState, scheduler, pipeline, clock, logger } = opts;
  const agents = new Set(team.people.map((p) => p.handle));

  // Checks never overlap: a tick, a hand-back and a connect may all ask at once.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const busy = async (person: string) =>
    (await store.listItems({ person })).some((i) => BUSY.has(i.status) && i.kind !== CHAT_KIND);

  const pull = async (person: string) => {
    const next = nextReadyTicket(workState.readyTickets(person));
    if (!next) {
      return;
    }

    const title = next.title?.includes(next.key) ? next.title : `${next.key} ${next.title ?? ""}`;
    const item = await scheduler.enqueue({
      person,
      kind: KIND,
      title: `${KIND}: ${title.trim()}`,
      trigger: TRIGGER,
      priority: priorityFor(TRIGGER, KIND),
      subject: { type: "ticket", ref: next.key },
      init: async (created) => {
        await store.appendJournal(
          created.id,
          "office",
          `${person} had nothing queued, so the office started ${next.key}, the next ready ticket assigned to them.`,
        );
      },
    });

    logger.info(`idle pull: queued work item ${item.id} for ${person} on ${next.key}`, {
      person,
      item: item.id,
      ticket: next.key,
    });
  };

  /** Whether the person is an agent with nothing to do and a ready ticket to start, and may start it now. */
  const shouldPull = async (person: string): Promise<boolean> => {
    if (!agents.has(person) || workState.readyTickets(person).length === 0) {
      return false;
    }

    if (await busy(person)) {
      return false;
    }

    const held = await scheduler.isPausedFor(person, { trigger: TRIGGER });
    if (held) {
      logger.debug(`idle pull: ${person} is held: ${held.reason}`, { person, code: held.code });
    }

    return !held;
  };

  const raise = async (person: string) => {
    if (!(await shouldPull(person))) {
      return;
    }

    const at = clock.now().toISOString();
    const event: PipelineEvent = {
      id: `office:idle:${person}:${at}`,
      type: "agent.idle",
      at,
      subject: {},
      actor: { kind: "agent", id: person },
      data: {},
    };

    await pipeline.idle(event, () => pull(person));
  };

  // Never throws: a failed check is logged, and the next hand-back, tick or connect checks again.
  const run = (people: () => Iterable<string>) =>
    serial(async () => {
      if (!policyOn(team.policies, "pull_ready")) {
        return;
      }

      try {
        await workState.refreshWorkers();
        for (const person of people()) {
          await raise(person);
        }
      } catch (error) {
        logger.warn("idle pull failed", { error: String(error) });
      }
    });

  /** The agent a ticket change may have given a ready ticket to. */
  const agentOf = (event: WorkflowEvent): string | undefined => {
    const key = event.subject.ticket;
    if (!key || !TICKET_CHANGES.has(event.type) || workState.ticketStatus(key) !== "ready") {
      return undefined;
    }

    const assignee = workState.assignee(key);
    return assignee?.kind === "agent" ? assignee.id : undefined;
  };

  return {
    check: (person) => run(() => [person]),
    sweep: () => run(() => agents),
    async afterEvent(event) {
      const person = agentOf(event);
      if (person) {
        await run(() => [person]);
      }
    },
  };
}

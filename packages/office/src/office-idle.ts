import { policyOn, type WorkflowEvent } from "@outstaff/core";
import type { IdlePull, IdlePullOptions } from "./office-idle.types.js";
import type { PipelineEvent } from "@outstaff/policy";
import { CHAT_KIND } from "./scheduler/index.js";

const TRIGGER = "automation";
const BUSY = new Set(["queued", "active"]);

/** Ticket changes that can give an agent a ready ticket. */
const TICKET_CHANGES = new Set(["ticket.created", "ticket.assigned", "ticket.moved"]);

/**
 * The idle pull (`policies.pull_ready`): an agent with no work item queued or running starts its next ready ticket.
 * Checked when a ticket change gives the agent a ready ticket, after a hand-back, on the scheduler's tick and when the
 * agent connects. The office raises `agent.idle` only when there is a ready ticket to start, so an idle team leaves no
 * trace every tick; the `idle_pulls_next` policy decides what it starts.
 */
export function createIdlePull(opts: IdlePullOptions): IdlePull {
  const { team, workState, scheduler, pipeline, clock, logger } = opts;
  const agents = new Set(team.people.map((p) => p.handle));

  // Checks never overlap: a tick, a hand-back and a connect may all ask at once.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const busy = async (person: string) =>
    (await opts.store.listItems({ person })).some(
      (i) => BUSY.has(i.status) && i.kind !== CHAT_KIND,
    );

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

    await pipeline.judge(event);
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

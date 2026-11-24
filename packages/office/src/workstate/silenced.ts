import type { WorkstateCore } from "./core.types.js";
import type { HeardEvent } from "./silenced.types.js";

/** Where the silent hand-backs are kept, one subject for the office: they must survive a restart. */
export const SILENCED_SUBJECT = "silenced";
const REF = "office";

const CLOSED = new Set(["done", "canceled"]);

/** The person's silent hand-back on the ticket that nothing from anyone else followed: when it was (ISO-8601). */
export const silencedAt = (core: Pick<WorkstateCore, "silenced">, ticket: string, person: string) =>
  core.silenced.get(ticket)?.get(person);

/** The ticket the event is about, or the one its pull request is linked to. */
function ticketOf(core: WorkstateCore, event: HeardEvent): string | undefined {
  const { ticket, pr } = event.subject;
  return ticket ?? (pr ? core.prs.get(core.prSubject(pr))?.ticket : undefined);
}

/**
 * Who keeps a hold on the ticket after the event: only the event's own actor. Anyone else acting on it (a comment, a
 * move, an assignment, a pull request or review, a sub-ticket changing state) releases everyone else's. The tracker's
 * echo of an office act (`data.echo`) is reported as the agent the act was for, so the restore of a silent hand-back
 * and the move of the round's start release nothing.
 */
const keeps = (event: HeardEvent) => (person: string) =>
  event.actor.kind === "agent" && event.actor.id === person;

/** The agent's own hand-back that is not silent, and a round a human asked for in chat, end its own hold too. */
const releasesOwn = (event: HeardEvent) =>
  event.type === "agent.handed_back" ||
  (event.type === "agent.started" && event.data["fromChat"] === true);

/**
 * The silent hand-backs of each agent on each ticket that nothing from anyone else followed (`policies.pull_ready`):
 * an idle pull does not hand the agent that ticket again, and a second silent hand-back on it is taken as blocked.
 */
export function createSilenced(core: WorkstateCore) {
  const { store, silenced } = core;

  const save = () =>
    store.upsertSubject(
      SILENCED_SUBJECT,
      REF,
      Object.fromEntries([...silenced].map(([key, holds]) => [key, Object.fromEntries(holds)])),
    );

  /** Drops the holds on the ticket the event leaves; returns whether any went. */
  const release = (key: string, event: HeardEvent, own: boolean): boolean => {
    const holds = silenced.get(key);
    if (!holds) {
      return false;
    }

    const kept = keeps(event);
    const gone = [...holds.keys()].filter(
      (person) => CLOSED.has(core.tickets.get(key)?.status ?? "") || !kept(person) || own,
    );

    for (const person of gone) {
      holds.delete(person);
    }

    if (holds.size === 0) {
      silenced.delete(key);
    }

    return gone.length > 0;
  };

  return {
    async load() {
      const data = (await store.getSubject(SILENCED_SUBJECT, REF))?.data as
        | Record<string, Record<string, string>>
        | undefined;

      silenced.clear();
      for (const [key, holds] of Object.entries(data ?? {})) {
        silenced.set(key, new Map(Object.entries(holds)));
      }
    },

    /**
     * Takes in an event the office judged. A silent hand-back holds its ticket for its agent. Any other event on the
     * ticket, its pull request or one of its sub-tickets releases the holds of everyone but its actor; the agent's own
     * hand-back that is not silent, and a round a human asked for in chat, release the agent's own as well.
     */
    async heard(event: HeardEvent): Promise<void> {
      const ticket = ticketOf(core, event);
      if (!ticket) {
        return;
      }

      if (event.type === "agent.handed_back" && event.data["status"] === "silent") {
        silenced.set(ticket, (silenced.get(ticket) ?? new Map()).set(event.actor.id, event.at));
        await save();
        return;
      }

      const parent = core.tickets.get(ticket)?.parent;
      const own = releasesOwn(event);
      const changed = [ticket, ...(parent ? [parent] : [])]
        .map((key) => release(key, event, own))
        .some(Boolean);

      if (changed) {
        await save();
      }
    },
  };
}

import type { WaitingAgent } from "@outstaff/policy";
import type { WorkstateCore } from "./core.types.js";
import type { HeardEvent } from "./silenced.types.js";
import type { HumanThread } from "./waiting.types.js";

/** Where the agents waiting on a human are kept, one subject for the office: they must survive a restart. */
export const WAITING_SUBJECT = "waiting_on_human";
const REF = "office";

const time = (iso: string) => Date.parse(iso);

/** The humans an agent's comment mentions, as tracker events name them (intake's `data.mentionedHumans`). */
const mentioned = (event: HeardEvent): string[] => {
  const found = event.data["mentionedHumans"];
  return Array.isArray(found) ? found.filter((h): h is string => typeof h === "string") : [];
};

/** A trusted human's comment, which answers whoever waits on them there. */
const byHuman = (event: HeardEvent) =>
  event.actor.kind === "human" && event.data["untrusted"] !== true;

/**
 * The agents waiting on a human on a ticket: an agent's comment there that mentions the human makes it wait, until
 * the office judged the human's next comment there. The tracker's echo of an office act is a note, not the agent asking.
 */
export function createWaiting(core: Pick<WorkstateCore, "store" | "clock" | "retentionMs">) {
  const { store, clock } = core;

  /** By ticket, then by human (lower case). */
  const tickets = new Map<string, Map<string, HumanThread>>();

  const thread = (ticket: string, human: string): HumanThread => {
    const humans = tickets.get(ticket) ?? new Map<string, HumanThread>();
    tickets.set(ticket, humans);
    const found = humans.get(human) ?? { asks: {} };
    humans.set(human, found);
    return found;
  };

  /** Drops what is older than the retention: an answer that never came, or a comment nobody waits on. */
  const prune = () => {
    const floor = clock.now().getTime() - core.retentionMs;
    for (const [ticket, humans] of tickets) {
      for (const [human, t] of humans) {
        t.asks = Object.fromEntries(Object.entries(t.asks).filter(([, a]) => time(a.at) >= floor));
        if (t.said && time(t.said) < floor) {
          delete t.said;
        }

        if (!t.said && Object.keys(t.asks).length === 0) {
          humans.delete(human);
        }
      }

      if (humans.size === 0) {
        tickets.delete(ticket);
      }
    }
  };

  const save = () => {
    prune();
    const data = Object.fromEntries(
      [...tickets].map(([ticket, humans]) => [ticket, Object.fromEntries(humans)]),
    );

    return store.upsertSubject(WAITING_SUBJECT, REF, data);
  };

  /** The agent asked each human it mentions, unless the human already spoke there after the comment. */
  const ask = (ticket: string, event: HeardEvent, humans: string[]) => {
    const url = event.data["url"];
    for (const human of humans) {
      const t = thread(ticket, human.toLowerCase());
      if (!t.said || time(t.said) < time(event.at)) {
        const agent = event.actor.id;
        t.asks[agent] = { agent, at: event.at, ...(typeof url === "string" ? { url } : {}) };
      }
    }
  };

  /** The human answered: everyone who asked them before this comment stops waiting. */
  const answer = (ticket: string, event: HeardEvent) => {
    const t = thread(ticket, event.actor.id.toLowerCase());
    if (!t.said || time(t.said) < time(event.at)) {
      t.said = event.at;
    }

    t.asks = Object.fromEntries(
      Object.entries(t.asks).filter(([, a]) => time(a.at) > time(event.at)),
    );
  };

  return {
    async load() {
      const data = (await store.getSubject(WAITING_SUBJECT, REF))?.data as
        | Record<string, Record<string, HumanThread>>
        | undefined;

      tickets.clear();
      for (const [ticket, humans] of Object.entries(data ?? {})) {
        tickets.set(ticket, new Map(Object.entries(humans)));
      }
    },

    /**
     * The agents waiting on the human on the ticket when they commented at `at`: those that mentioned them there
     * before it, after their last comment, oldest first.
     */
    waitingOn(ticket: string, human: string, at: string): WaitingAgent[] {
      const t = tickets.get(ticket)?.get(human.toLowerCase());
      return Object.values(t?.asks ?? {})
        .filter((a) => time(a.at) <= time(at))
        .toSorted((a, b) => time(a.at) - time(b.at));
    },

    /** Takes in a comment the office judged: an agent's mention of a human makes it wait, the human's comment answers. */
    async heard(event: HeardEvent): Promise<void> {
      const ticket = event.subject.ticket;
      if (event.type !== "ticket.commented" || !ticket || typeof event.data["echo"] === "string") {
        return;
      }

      const humans = event.actor.kind === "agent" ? mentioned(event) : [];
      if (humans.length > 0) {
        ask(ticket, event, humans);
      } else if (byHuman(event)) {
        answer(ticket, event);
      } else {
        return;
      }

      await save();
    },
  };
}

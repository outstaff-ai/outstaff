import type { ActOp } from "@outstaff/core";
import type { PipelineEvent, PolicyState } from "@outstaff/policy";
import type { Clock } from "#/types.js";
import type { Store } from "#/store/types.js";
import type { ActEchoes, PendingAct } from "./act.types.js";

/** The changes the office's acts are expected to come back as from the tracker, kept per ticket. */
export const ACT_ECHO_SUBJECT = "act_echo";

/** How long a change is expected back: an agent offline longer makes it later, and its echo is an ordinary event. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** One change of an act, waiting for its echo. */
interface Expected {
  act: string;

  /** Its place in the act's changes: an act sent again is expected once. */
  index: number;
  person: string;
  type: PipelineEvent["type"];

  /** What the change leaves: the assignee's id (null for none), the status, or the comment's body. */
  to: string | null;
  sentAt: string;

  /** The event that was its echo; that event, delivered again, is still the echo. */
  echo?: string | undefined;
}

interface Book {
  expected: Expected[];
}

/** The ticket a change is on, the tracker event it comes back as and what it leaves; nothing for a parent change. */
function echoOf(op: ActOp): (Pick<Expected, "type" | "to"> & { ticket: string }) | undefined {
  switch (op.op) {
    case "assign":
      return { ticket: op.ticket, type: "ticket.assigned", to: op.to?.id ?? null };
    case "move":
      return { ticket: op.ticket, type: "ticket.moved", to: op.to };
    case "comment":
      return "ticket" in op.on
        ? { ticket: op.on.ticket, type: "ticket.commented", to: op.body }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether the event shows what the change leaves: the ticket assigned to its assignee or in its status, as the state
 * read after the event has it (the same state the policies judge), or a comment with its body.
 */
function shows(e: Expected, event: PipelineEvent, ticket: string, state: PolicyState): boolean {
  switch (event.type) {
    case "ticket.assigned":
      return (state.assignee(ticket)?.id ?? null) === e.to;
    case "ticket.moved":
      return state.ticketStatus(ticket) === e.to;
    default:
      return event.data["body"] === e.to;
  }
}

/**
 * Recognises the tracker's echo of a change an act made (decision 0022). The agent an act is for makes its changes
 * with its own identity, so the tracker reports them as that agent's: "assigned to pia by sam". Each change is
 * expected from the moment the act is sent, before the agent answers, since the tracker may report it first. The
 * first event of the change's kind on its ticket by the acting agent that shows what the change leaves is its echo,
 * and the change is then spent.
 */
export function createActEchoes(
  store: Pick<Store, "getSubject" | "upsertSubject">,
  clock: Clock,
): ActEchoes {
  // Read, change, write: one at a time, so two changes to one ticket's book do not overwrite each other.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const read = async (ticket: string): Promise<Book> =>
    ((await store.getSubject(ACT_ECHO_SUBJECT, ticket))?.data as Book | undefined) ?? {
      expected: [],
    };

  const fresh = (e: Expected) => clock.now().getTime() - Date.parse(e.sentAt) < KEEP_MS;

  return {
    expect: (person, act: PendingAct) =>
      locked(async () => {
        const sentAt = clock.now().toISOString();
        const byTicket = new Map<string, Expected[]>();
        act.ops.forEach((op, index) => {
          const change = echoOf(op);
          if (change) {
            const { ticket, type, to } = change;
            byTicket.set(ticket, [
              ...(byTicket.get(ticket) ?? []),
              { act: act.id, index, person, type, to, sentAt },
            ]);
          }
        });

        for (const [ticket, added] of byTicket) {
          const book = await read(ticket);
          const known = (e: Expected) =>
            book.expected.some((x) => x.act === e.act && x.index === e.index);

          await store.upsertSubject(ACT_ECHO_SUBJECT, ticket, {
            expected: [...book.expected.filter(fresh), ...added.filter((e) => !known(e))],
          });
        }
      }),

    of: (event, state) =>
      locked(async () => {
        const ticket = event.subject.ticket;
        if (event.actor.kind !== "agent" || !ticket) {
          return undefined;
        }

        const book = await read(ticket);
        const echoed = (e: Expected) =>
          e.person === event.actor.id &&
          e.type === event.type &&
          fresh(e) &&
          (e.echo === undefined || e.echo === event.id) &&
          shows(e, event, ticket, state);

        const hit = book.expected.find(echoed);
        if (!hit) {
          return undefined;
        }

        if (hit.echo === undefined) {
          await store.upsertSubject(ACT_ECHO_SUBJECT, ticket, {
            expected: book.expected.map((e) => (e === hit ? { ...e, echo: event.id } : e)),
          });
        }

        return hit.act;
      }),
  };
}

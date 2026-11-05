import type { ActOp, TeamConfig, TicketAssignee } from "@outstaff/core";
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
 * How much earlier than the act an event may say it happened and still be its echo: the tracker's clock and the
 * office's may differ a little.
 */
const SKEW_MS = 5_000;

const lower = (name: string) => name.toLowerCase();

type People = Pick<TeamConfig, "people" | "humans">;

const defined = (names: (string | null | undefined)[]): string[] =>
  names.filter((n): n is string => typeof n === "string" && n !== "");

/**
 * The names the act's assignee goes by: as the act names them, and from the team file an agent's tracker identity and
 * name, or the name of the human whose tracker identity it is.
 */
function namesOf(to: string, team: People): string[] {
  const agent = team.people.find((p) => p.handle === to);
  const human = team.humans?.find((h) => h.identities.tracker?.toLowerCase() === lower(to));
  return defined([to, agent?.identities?.tracker, agent?.name, human?.name]);
}

/** Whether two lists of names share one, in any case: an act and a tracker may name one member differently. */
const overlap = (a: string[], b: string[]) => {
  const known = new Set(a.map(lower));
  return b.some((name) => known.has(lower(name)));
};

/** The names of whom the assignment event says it left the ticket with: null for no one, undefined when it does not say. */
function saidAssignee(event: PipelineEvent): string[] | null | undefined {
  const { assignee, to } = event.data;
  if (assignee === null) {
    return null;
  }

  const member = (assignee ?? {}) as { id?: unknown; username?: unknown; name?: unknown };
  const names = defined(
    [member.id, member.username, member.name, to].map((n) =>
      typeof n === "string" ? n : undefined,
    ),
  );

  return names.length > 0 ? names : undefined;
}

const namesNow = (now: TicketAssignee) => [now.id, ...(now.names ?? [])];

/**
 * Whether the assignment event shows the change: the event's own assignee is the act's. The act names an agent by
 * handle and a human by a tracker identity (a member id, username or display name), and the tracker may name the
 * member by another; the state's assignee bridges them when it is the act's. An event that does not say whom it
 * assigned (some trackers' feeds do not) is judged by the state after it, the best there is.
 */
function assignedAsExpected(
  e: Expected,
  event: PipelineEvent,
  now: TicketAssignee | undefined,
  team: People,
) {
  const said = saidAssignee(event);
  if (e.to === null) {
    return said === undefined ? now === undefined : said === null;
  }

  const wanted = namesOf(e.to, team);
  const known = now && overlap(namesNow(now), wanted) ? [...wanted, ...namesNow(now)] : wanted;
  if (said === undefined) {
    return now !== undefined && overlap(known, namesNow(now));
  }

  return said !== null && overlap(known, said);
}

/** The status the move event says it left the ticket in; undefined for one the team's statuses do not map. */
function saidStatus(event: PipelineEvent): string | undefined {
  const to = event.data["to"];
  return typeof to === "string" ? to : undefined;
}

/**
 * Whether the event shows what the change leaves: the ticket assigned to its assignee or moved to its status, as the
 * event itself says, or a comment with its body. An event that is late shows the change it reports, not the state
 * now: the start of a round processed after its hand-back must not pass for the hand-back's echo. Only a move that
 * does not say its status (one the team's statuses do not map) is judged by the state after it.
 */
function shows(
  e: Expected,
  event: PipelineEvent,
  ticket: string,
  state: PolicyState,
  team: People,
): boolean {
  switch (event.type) {
    case "ticket.assigned":
      return assignedAsExpected(e, event, state.assignee(ticket), team);
    case "ticket.moved":
      return (saidStatus(event) ?? state.ticketStatus(ticket)) === e.to;
    default:
      return event.data["body"] === e.to;
  }
}

/** Whether the event happened after the change was sent, within the clocks' skew. An unknown time does not rule it out. */
const after = (e: Expected, event: PipelineEvent) =>
  !(Date.parse(event.at) < Date.parse(e.sentAt) - SKEW_MS);

/**
 * Recognises the tracker's echo of a change an act made (decision 0022). The agent an act is for makes its changes
 * with its own identity, so the tracker reports them as that agent's: "assigned to pia by sam". Each change is
 * expected from the moment the act is sent, before the agent answers, since the tracker may report it first. The
 * first event of the change's kind on its ticket by the acting agent, from after the act was sent, that shows what the
 * change leaves is its echo, and the change is then spent.
 */
export function createActEchoes(
  store: Pick<Store, "getSubject" | "upsertSubject">,
  clock: Clock,
  team: People,
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
          after(e, event) &&
          shows(e, event, ticket, state, team);

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

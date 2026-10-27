import type {
  CanonicalStatus,
  Issue,
  Member,
  TeamConfig,
  Tracker,
  WorkflowEvent,
} from "@outstaff/core";
import type { WorkItem } from "../store/index.js";
import type { TicketOps, WorkstateCore } from "./core.types.js";
import { notFound } from "./derive.js";
import { personNode, prNode, relink, ROOT, ticketNode } from "./links.js";
import { priorityOf, statusSince } from "./ready.js";
import type { TicketRecord } from "./types.js";

/** Whom the event names as the human asking for the work: its actor, when that is a trusted human. */
export const trustedHuman = (event: WorkflowEvent): string | undefined =>
  event.actor.kind === "human" && event.data["untrusted"] !== true ? event.actor.id : undefined;

/** The events whose human actor asks for the work. */
const REQUESTING = new Set<string>(["ticket.created", "ticket.assigned"]);

const PENDING = new Set<string>(["queued", "waiting"]);

/** The person node of an assignee who is one of the team's agents. */
const agentNode = (team: TeamConfig, a?: TicketRecord["assignee"]) =>
  a?.kind === "agent" && team.people.some((p) => p.handle === a.id) ? personNode(a.id) : undefined;

/** Who the previous record says asked for the work, carried over to a record read anew. */
const keptRequester = (prev?: TicketRecord) => ({
  ...(prev?.requester ? { requester: prev.requester } : {}),
  ...(prev?.requesterAt ? { requesterAt: prev.requesterAt } : {}),
});

/** An item not started yet on the ticket or on one of its pull requests. */
function pendingOn(item: WorkItem, key: string, prKeys: Set<string>): boolean {
  const on = item.subject;
  if (!on || !PENDING.has(item.status)) {
    return false;
  }

  return on.type === "ticket" ? on.ref === key : on.type === "pr" && prKeys.has(on.ref);
}

/** When the tracker says the event happened, if it says. */
const eventAt = (event?: WorkflowEvent): string | undefined => {
  const at = event?.data["at"];
  return typeof at === "string" && at !== "" ? at : undefined;
};

/** Ticket records: read from the tracker, saved, and forgotten when the tracker no longer has them. */
export function createTickets(core: WorkstateCore): TicketOps {
  const {
    store,
    team,
    clock,
    logger,
    tracker,
    tickets,
    prs,
    trackerPeople,
    notTickets,
    prSubject,
  } = core;

  const assigneeOf = (member?: Member): TicketRecord["assignee"] => {
    if (!member) {
      return undefined;
    }

    if (member.kind === "agent") {
      const handle =
        trackerPeople.get(member.id) ?? (member.username && trackerPeople.get(member.username));

      return { id: handle || member.id, kind: "agent" };
    }

    return { id: member.username ?? member.id, kind: "human" };
  };

  const saveTicket = async (rec: TicketRecord) => {
    const prev = tickets.get(rec.key);
    tickets.set(rec.key, rec);
    await store.upsertSubject("ticket", rec.key, rec);
    await store.link(ROOT, ticketNode(rec.key), "tracks");
    await relink(
      store,
      ticketNode(rec.key),
      "assigned_to",
      agentNode(team, prev?.assignee),
      agentNode(team, rec.assignee),
    );
  };

  const toTicket = (issue: Issue, prev?: TicketRecord, event?: WorkflowEvent): TicketRecord => {
    const status = issue.status.canonical ?? prev?.status;
    const assignee = assigneeOf(issue.assignee);
    return {
      key: issue.key,
      title: issue.title,
      url: issue.url,
      ...(status ? { status } : {}),
      ...statusSince(
        prev,
        status,
        eventAt(event) ?? issue.updatedAt,
        event?.type === "ticket.moved",
      ),
      ...priorityOf(issue),
      ...(assignee ? { assignee } : {}),
      labels: [...issue.labels],
      ...keptRequester(prev),
      updatedAt: clock.now().toISOString(),
    };
  };

  /** Takes the ticket off its pull requests; the keys of those pull requests. */
  const unlinkPrs = async (key: string): Promise<Set<string>> => {
    const prKeys = new Set<string>();
    for (const rec of [...prs.values()].filter((p) => p.ticket === key)) {
      const { ticket: _ticket, ...unlinked } = rec;
      const prKey = prSubject(rec.ref);
      prKeys.add(prKey);
      prs.set(prKey, unlinked);
      await store.upsertSubject("pr", prKey, unlinked);
      await store.unlink(prNode(prKey), ticketNode(key), "implements");
    }

    return prKeys;
  };

  /** Cancels the work that has not started on the ticket or its pull requests. */
  const cancelPending = async (key: string, prKeys: Set<string>) => {
    const note = `Ticket ${key} no longer exists in the tracker.`;
    for (const item of await store.listItems()) {
      if (pendingOn(item, key, prKeys)) {
        await store.updateItem(item.id, { status: "canceled" });
        await store.appendJournal(item.id, "office", note);
      }
    }
  };

  /**
   * The tracker no longer has the ticket: remember that, close what hung on it, and stop asking.
   * A ticket the work state never held only gets the warning.
   */
  const forgetTicket = async (key: string, prev?: TicketRecord) => {
    if (!prev) {
      logger.warn("ticket not found", { key });
      return;
    }

    if (prev.goneAt) {
      return;
    }

    logger.warn("ticket not found, forgetting it", { key });
    const at = clock.now().toISOString();
    const gone: TicketRecord = {
      key,
      title: prev.title,
      ...(prev.url ? { url: prev.url } : {}),
      labels: [],
      goneAt: at,
      updatedAt: at,
    };

    tickets.set(key, gone);
    await store.upsertSubject("ticket", key, gone);
    const assignee = agentNode(team, prev.assignee);
    if (assignee) {
      await store.unlink(ticketNode(key), assignee, "assigned_to");
    }

    await cancelPending(key, await unlinkPrs(key));
  };

  /** The ticket as the tracker has it; undefined when the tracker no longer has it. */
  const readTicket = async (
    from: Tracker,
    key: string,
    prev?: TicketRecord,
    event?: WorkflowEvent,
  ) => {
    try {
      return toTicket(await from.getIssue(key), prev, event);
    } catch (error) {
      if (notFound(error)) {
        await forgetTicket(key, prev);
        return undefined;
      }

      throw error;
    }
  };

  /** Without a tracker the events are all there is to go on. */
  const fromEvent = (key: string, prev?: TicketRecord, event?: WorkflowEvent): TicketRecord => {
    const now = clock.now().toISOString();
    const rec = prev ?? { key, title: key, labels: [], updatedAt: now };
    const to = event?.data["to"];
    if (event?.type !== "ticket.moved" || typeof to !== "string") {
      return rec;
    }

    const status = to as CanonicalStatus;
    return { ...rec, status, ...statusSince(prev, status, eventAt(event) ?? now, true) };
  };

  /** The record with the human who created or assigned the ticket as its requester. */
  const withEventRequester = (rec: TicketRecord, event?: WorkflowEvent) => {
    const requestedBy = event && REQUESTING.has(event.type) ? trustedHuman(event) : undefined;
    return requestedBy && event ? withRequester(rec, requestedBy, event) : rec;
  };

  const refreshTicket = async (key: string, event?: WorkflowEvent) => {
    const prev = tickets.get(key);
    if (prev?.goneAt && !event) {
      return;
    }

    const rec = tracker ? await readTicket(tracker, key, prev, event) : fromEvent(key, prev, event);
    if (rec) {
      await saveTicket(withEventRequester(rec, event));
    }
  };

  const withRequester = (rec: TicketRecord, requester: string, event: WorkflowEvent) => {
    const at = typeof event.data["at"] === "string" ? event.data["at"] : clock.now().toISOString();
    return rec.requesterAt && Date.parse(at) < Date.parse(rec.requesterAt)
      ? rec
      : { ...rec, requester, requesterAt: at };
  };

  const ensureTicket = async (key: string): Promise<boolean> => {
    if (tickets.has(key)) {
      return !tickets.get(key)!.goneAt;
    }

    if (notTickets.has(key)) {
      return false;
    }

    await refreshTicket(key);
    if (tickets.has(key)) {
      return !tickets.get(key)!.goneAt;
    }

    notTickets.add(key);
    return false;
  };

  return { saveTicket, toTicket, refreshTicket, ensureTicket, withRequester };
}

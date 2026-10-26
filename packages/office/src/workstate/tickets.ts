import type { CanonicalStatus, Issue, Member, WorkflowEvent } from "@outstaff/core";
import type { TicketOps, WorkstateCore } from "./core.types.js";
import { notFound } from "./derive.js";
import { personNode, prNode, relink, ROOT, ticketNode } from "./links.js";
import type { TicketRecord } from "./types.js";

/** Whom the event names as the human asking for the work: its actor, when that is a trusted human. */
export const trustedHuman = (event: WorkflowEvent): string | undefined =>
  event.actor.kind === "human" && event.data["untrusted"] !== true ? event.actor.id : undefined;

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
    const person = (a?: TicketRecord["assignee"]) =>
      a?.kind === "agent" && team.people.some((p) => p.handle === a.id)
        ? personNode(a.id)
        : undefined;

    await relink(
      store,
      ticketNode(rec.key),
      "assigned_to",
      person(prev?.assignee),
      person(rec.assignee),
    );
  };

  const toTicket = (issue: Issue, prev?: TicketRecord): TicketRecord => {
    const status = issue.status.canonical ?? prev?.status;
    const assignee = assigneeOf(issue.assignee);
    return {
      key: issue.key,
      title: issue.title,
      url: issue.url,
      ...(status ? { status } : {}),
      ...(assignee ? { assignee } : {}),
      labels: [...issue.labels],
      ...(prev?.requester ? { requester: prev.requester } : {}),
      ...(prev?.requesterAt ? { requesterAt: prev.requesterAt } : {}),
      updatedAt: clock.now().toISOString(),
    };
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
    const note = `Ticket ${key} no longer exists in the tracker.`;
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
    const assignee = prev.assignee;
    if (assignee?.kind === "agent" && team.people.some((p) => p.handle === assignee.id)) {
      await store.unlink(ticketNode(key), personNode(assignee.id), "assigned_to");
    }

    const linked = [...prs.values()].filter((p) => p.ticket === key);
    const prKeys = new Set<string>();
    for (const rec of linked) {
      const { ticket: _ticket, ...unlinked } = rec;
      const prKey = prSubject(rec.ref);
      prKeys.add(prKey);
      prs.set(prKey, unlinked);
      await store.upsertSubject("pr", prKey, unlinked);
      await store.unlink(prNode(prKey), ticketNode(key), "implements");
    }

    for (const item of await store.listItems()) {
      const on = item.subject;
      if (
        (item.status === "queued" || item.status === "waiting") &&
        on &&
        ((on.type === "ticket" && on.ref === key) || (on.type === "pr" && prKeys.has(on.ref)))
      ) {
        await store.updateItem(item.id, { status: "canceled" });
        await store.appendJournal(item.id, "office", note);
      }
    }
  };

  const refreshTicket = async (key: string, event?: WorkflowEvent) => {
    const prev = tickets.get(key);
    if (prev?.goneAt && !event) {
      return;
    }

    let rec: TicketRecord;
    if (tracker) {
      try {
        rec = toTicket(await tracker.getIssue(key), prev);
      } catch (error) {
        if (notFound(error)) {
          await forgetTicket(key, prev);
          return;
        }

        throw error;
      }
    } else {
      // Without a tracker the events are all there is to go on.
      rec = prev ?? { key, title: key, labels: [], updatedAt: clock.now().toISOString() };
      const to = event?.data["to"];
      if (event?.type === "ticket.moved" && typeof to === "string") {
        rec = { ...rec, status: to as CanonicalStatus };
      }
    }

    const requestedBy =
      event && ["ticket.created", "ticket.assigned"].includes(event.type)
        ? trustedHuman(event)
        : undefined;

    await saveTicket(requestedBy && event ? withRequester(rec, requestedBy, event) : rec);
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

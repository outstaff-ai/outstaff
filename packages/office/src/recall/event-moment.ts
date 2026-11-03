import type { PrRef, WorkflowEvent } from "@outstaff/core";
import { chatThreadRef, conversationRef } from "#/refs/index.js";
import type { MomentRef, NewMoment } from "#/store/types.js";

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** What happened, in words, for the events that are not a text of their own. */
const DONE: Record<string, (d: Record<string, unknown>) => string> = {
  "ticket.created": () => "created",
  "ticket.assigned": () => "assigned",
  "ticket.moved": (d) =>
    ["moved", str(d["from"]) && `from ${str(d["from"])}`, str(d["to"]) && `to ${str(d["to"])}`]
      .filter(Boolean)
      .join(" "),
  "ticket.commented": () => "",
  "ticket.closed": (d) => `closed${str(d["status"]) ? ` as ${str(d["status"])}` : ""}`,
  "pr.opened": () => "opened",
  "pr.merged": () => "merged",
  "pr.closed": () => "closed",
  "pr.review_submitted": (d) => `review: ${(str(d["state"]) ?? "commented").replaceAll("_", " ")}`,
  "pr.comment": () => "",
  "doc.commented": () => "",
  "chat.message": () => "",
};

/** Events that name what they are about by title: the title is part of what they say. */
const TITLED = new Set(["ticket.created", "pr.opened"]);

interface ChatMessage {
  channel: string;
  messageId: string;
  thread?: string;
  author?: { id: string; name?: string };
}

const chatMessage = (data: Record<string, unknown>) => {
  const m = data["message"] as Partial<ChatMessage> | undefined;
  return typeof m?.channel === "string" && typeof m.messageId === "string"
    ? (m as ChatMessage)
    : undefined;
};

/** Where it happened: the chat thread (as chat sessions refer to it), the document, the pull request or the ticket. */
function whereOf(event: WorkflowEvent, prKey: (pr: PrRef) => string): MomentRef | null {
  const { subject, data } = event;
  const m = event.type === "chat.message" ? chatMessage(data) : undefined;
  if (m) {
    return { type: "chat_thread", ref: chatThreadRef(m.channel, m.thread ?? m.messageId) };
  }

  if (subject.chat) {
    return { type: "chat_thread", ref: conversationRef(subject.chat) };
  }

  if (subject.doc) {
    return { type: "doc", ref: subject.doc };
  }

  if (subject.pr) {
    return { type: "pr", ref: prKey(subject.pr) };
  }

  return subject.ticket ? { type: "ticket", ref: subject.ticket } : null;
}

/** What the event says: what was done, the title for a new ticket or pull request, and the text written. */
function textOf(event: WorkflowEvent): string {
  const { data, type } = event;
  return [DONE[type]!(data), TITLED.has(type) ? str(data["title"]) : undefined, str(data["body"])]
    .filter(Boolean)
    .join(": ");
}

/**
 * An event as a moment of the history agents recall: comments, reviews, moves, merges and closes on tickets, pull
 * requests and documents (seen by every agent whose work refers to them), and chat messages, which belong to the agent
 * they were written to. Undefined for the events that are not something said or done by someone (CI, the office's
 * own events).
 */
/** Whose moment the event is, and what it says; undefined when it says nothing or is no one's. */
function saidBy(event: WorkflowEvent): { person: string | null; text: string } | undefined {
  // A chat message is only ever its addressee's: without one it is no one's moment.
  const person = event.type === "chat.message" ? str(event.data["addressed"]) : null;
  const text = event.type in DONE ? textOf(event) : "";
  return text === "" || person === undefined ? undefined : { person, text };
}

const authorName = (data: Record<string, unknown>) => chatMessage(data)?.author?.name ?? null;

export function eventMoment(
  event: WorkflowEvent,
  id: string,
  at: string,
  prKey: (pr: PrRef) => string,
): NewMoment | undefined {
  const said = saidBy(event);
  if (!said) {
    return undefined;
  }

  return {
    key: `event:${id}`,
    ...said,
    at: str(event.data["at"]) ?? at,
    kind: event.type,
    subject: whereOf(event, prKey),
    actor: event.actor.id,
    actorName: authorName(event.data),
    url: str(event.data["url"]) ?? null,
  };
}

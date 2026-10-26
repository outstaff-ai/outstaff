import type { LinkSource, LinkTrace } from "@outstaff/protocol";
import type { Trace } from "../pipeline/trace.types.js";
import type { SubjectLinks } from "./link.types.js";

const SOURCES: Record<string, LinkSource> = {
  vcs: "vcs",
  tracker: "tracker",
  knowledge: "knowledge",
  chat: "chat",
};

/** Where an event came from, by its id's prefix; the office's own events (work state, merges, hand-backs) are `office`. */
export const sourceOf = (id: string): LinkSource => SOURCES[id.split(":")[0]!] ?? "office";

const link = <T>(make: ((value: T) => string) | undefined, value: T | undefined) =>
  make && value !== undefined ? make(value) : undefined;

/** Links to an event's subject: the ticket, pull request and document from the adapters, a chat message's own link. */
function urlsOf(trace: Trace, links: SubjectLinks): LinkTrace["urls"] {
  const { subject, data } = trace.event;
  const chat =
    trace.event.type === "chat.message" && typeof data["url"] === "string"
      ? data["url"]
      : undefined;

  const urls = {
    ticket: link(links.ticket, subject.ticket),
    pr: link(links.pr, subject.pr),
    doc: link(links.doc, subject.doc),
    chat,
  };

  return Object.fromEntries(Object.entries(urls).filter(([, url]) => url !== undefined));
}

/** A trace as the office link sends it: with where its event came from and links to its subject. */
export function present(trace: Trace, links: SubjectLinks): LinkTrace {
  return {
    ...trace,
    event: { ...trace.event, source: sourceOf(trace.event.id) },
    urls: urlsOf(trace, links),
  } as LinkTrace;
}

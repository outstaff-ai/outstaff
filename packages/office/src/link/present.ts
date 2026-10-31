import type { Logger } from "@outstaff/core";
import { traceSchema } from "@outstaff/protocol";
import type { LinkSource, LinkTrace } from "@outstaff/protocol";
import type { Trace } from "#/pipeline/trace.types.js";
import type { OfficeLinkOptions, SubjectLinks } from "./link.types.js";

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

type Loose = Record<string, unknown>;

const proposalsSchema = traceSchema.shape.policies.element.shape.proposals;

/**
 * One policy's run in the link's shape. A trace recorded before policies proposed kept a `decisions` list on each
 * policy instead; it becomes the proposals only where it reads as them, else the policy shows none.
 */
function policyOf(raw: unknown) {
  const p = (raw ?? {}) as Loose;
  const listed = p["proposals"] ?? p["decisions"];
  return {
    policy: p["policy"],
    matched: p["matched"],
    reason: p["reason"],
    ...(p["failed"] === undefined ? {} : { failed: p["failed"] }),
    proposals: proposalsSchema.safeParse(listed).success ? listed : [],
  };
}

/** The event and its links: what lists a trace, so even one the office can no longer read shows up. */
function headOf(trace: Trace, links: SubjectLinks) {
  const { id, type, at, subject, actor, data } = trace.event;
  return {
    event: { id, source: sourceOf(String(id)), type, at, subject, actor, data },
    urls: urlsOf(trace, links),
  };
}

/** The stored trace in the link's shape, with only the link's own fields: not what the office alone keeps. */
function fitted(trace: Trace, links: SubjectLinks): unknown {
  const t = trace as unknown as Loose;
  return {
    ...headOf(trace, links),
    policies: Array.isArray(t["policies"]) ? t["policies"].map(policyOf) : t["policies"],
    // A trace recorded before the aggregation layer has none.
    aggregation: t["aggregation"] ?? [],
    decisions: t["decisions"] ?? [],
    ...(t["results"] === undefined ? {} : { results: t["results"] }),
  };
}

/** Trace ids already logged as unreadable, per office (its logger), so a page asked for again logs nothing new. */
const logged = new WeakMap<Logger, Set<string>>();

function logOnce(logger: Logger, id: string, issues: unknown) {
  const seen = logged.get(logger) ?? new Set<string>();
  logged.set(logger, seen);
  if (!seen.has(id)) {
    seen.add(id);
    logger.debug("office link: a stored trace does not fit the link; sending its event alone", {
      event: id,
      issues,
    });
  }
}

/**
 * A trace as the office link sends it: with where its event came from and links to its subject. Always one the link's
 * strict schema reads, or a client could read no page with it on: the office's own fields (each wake's context
 * manifest) are left out, a trace recorded by an older office is brought to the current shape where it maps cleanly,
 * and one that still does not fit is sent as its event and links alone, so the event still lists.
 */
export function present(
  trace: Trace,
  opts: Pick<OfficeLinkOptions, "links" | "logger">,
): LinkTrace {
  const parsed = traceSchema.safeParse(fitted(trace, opts.links));
  if (parsed.success) {
    return parsed.data;
  }

  logOnce(opts.logger, String(trace.event.id), parsed.error.issues);
  return {
    ...headOf(trace, opts.links),
    policies: [],
    aggregation: [],
    decisions: [],
  } as LinkTrace;
}

import type {
  ContextChat,
  ContextDoc,
  ContextPr,
  ContextTicket,
  WakeContext,
} from "@outstaff/protocol";
import type {
  ContextGraph,
  ContextLimits,
  ContextManifest,
  ContextNode,
  GraphTicket,
  ManifestEntry,
} from "./context.types.js";
import { isOpen } from "#/workstate/open.js";
import { walkGraph } from "./walk.js";

/** Text cut to the limit, saying so: the link has the rest. */
export function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()} ... (cut; the link has the rest)` : t;
}

/** The last `n` of a list, and how many were left out before them. */
function latest<T>(list: T[], n: number): { shown: T[]; left: number } {
  const shown = n > 0 ? list.slice(-n) : [];
  return { shown, left: list.length - shown.length };
}

const more = (left: number) => (left > 0 ? left : undefined);

type Filled =
  | { kind: "tickets"; value: ContextTicket; entry: ManifestEntry }
  | { kind: "prs"; value: ContextPr; entry: ManifestEntry }
  | { kind: "docs"; value: ContextDoc; entry: ManifestEntry }
  | { kind: "chats"; value: ContextChat; entry: ManifestEntry };

type Filler = (graph: ContextGraph, node: ContextNode, limits: ContextLimits) => Filled | undefined;

const entryOf = (
  node: ContextNode,
  url: string | undefined,
  counts?: { shown: number; left: number },
): ManifestEntry => ({
  type: node.type,
  ref: node.ref,
  ...(url ? { url } : {}),
  why: node.why,
  ...counts,
});

function ticketValue(t: GraphTicket, node: ContextNode, limits: ContextLimits) {
  const { shown, left } = latest(t.comments, limits.comments);
  const url = t.url ?? node.url;
  const value: ContextTicket = {
    key: t.key,
    title: t.title,
    ...(url ? { url } : {}),
    ...(t.status ? { status: t.status } : {}),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.description?.trim() ? { description: cut(t.description, limits.bodyChars) } : {}),
    comments: shown.map((c) => ({ ...c, body: cut(c.body, limits.bodyChars) })),
    ...(more(left) ? { moreComments: left } : {}),
    why: node.why,
  };

  return { value, url, shown: shown.length, left };
}

const ticket: Filler = (graph, node, limits) => {
  const t = graph.tickets.find((x) => x.key === node.ref);
  if (!t) {
    return undefined;
  }

  const { value, url, shown, left } = ticketValue(t, node, limits);
  return { kind: "tickets", value, entry: entryOf(node, url, { shown, left }) };
};

const pr: Filler = (graph, node, limits) => {
  const p = graph.prs.find((x) => x.ref === node.ref);
  if (!p) {
    return undefined;
  }

  const threads = p.threads.slice(0, limits.threads);
  const url = p.url ?? node.url;
  const value: ContextPr = {
    ref: p.ref,
    number: p.number,
    title: p.title,
    ...(url ? { url } : {}),
    state: p.state,
    draft: p.draft,
    ci: p.ci,
    failing: p.checks.filter((c) => c.status === "failure").map((c) => c.name),
    mergeable: p.mergeable,
    ...(p.review ? { review: p.review } : {}),
    unresolvedThreads: p.unresolvedThreads,
    threads: threads.map((t) => ({ ...t, body: cut(t.body, limits.bodyChars) })),
    ...(p.ticket ? { ticket: p.ticket } : {}),
    ...(p.stackedOn ? { stackedOn: p.stackedOn } : {}),
    stackedBy: graph.prs.filter((x) => x.stackedOn === p.ref && isOpen(x)).map((x) => x.ref),
    why: node.why,
  };

  const left = Math.max(p.unresolvedThreads, p.threads.length) - threads.length;
  return { kind: "prs", value, entry: entryOf(node, url, { shown: threads.length, left }) };
};

const doc: Filler = (graph, node) => {
  const d = graph.docs.find((x) => x.id === node.ref);
  if (!d) {
    return undefined;
  }

  const url = d.url ?? node.url;
  const value: ContextDoc = {
    id: d.id,
    title: d.title,
    ...(url ? { url } : {}),
    ...(d.ticket ? { ticket: d.ticket } : {}),
    why: node.why,
  };

  return { kind: "docs", value, entry: entryOf(node, url) };
};

const chat: Filler = (graph, node, limits) => {
  const c = graph.chats.find((x) => x.key === node.ref);
  if (!c) {
    return undefined;
  }

  const { shown, left } = latest(c.messages, limits.messages);
  const value: ContextChat = {
    channel: c.channel,
    thread: c.thread,
    messages: shown.map((m) => ({ ...m, text: cut(m.text, limits.bodyChars) })),
    ...(more(left) ? { moreMessages: left } : {}),
    why: node.why,
  };

  return { kind: "chats", value, entry: entryOf(node, undefined, { shown: shown.length, left }) };
};

const FILLERS: Record<ContextNode["type"], Filler> = { ticket, pr, doc, chat_thread: chat };

/**
 * The context bundle of one wake, from a snapshot of what the office knows around the item: every linked ticket,
 * pull request, document and chat thread it has data for, closest first, at most `limits.items`, each with its link
 * and why it belongs. Comments, threads and messages are the latest few, and long text is cut. Pure.
 */
export function buildWakeContext(
  graph: ContextGraph,
  limits: ContextLimits,
): { context: WakeContext; manifest: ContextManifest } {
  const filled = walkGraph(graph)
    .map((node) => FILLERS[node.type](graph, node, limits))
    .filter((f) => f !== undefined);

  const kept = filled.slice(0, limits.items);
  const omitted = filled.length - kept.length;
  const context: WakeContext = { tickets: [], prs: [], docs: [], chats: [] };
  for (const f of kept) {
    (context[f.kind] as (typeof f.value)[]).push(f.value);
  }

  return {
    context: omitted > 0 ? { ...context, omitted } : context,
    manifest: { itemId: graph.itemId, entries: kept.map((f) => f.entry), omitted, limits },
  };
}

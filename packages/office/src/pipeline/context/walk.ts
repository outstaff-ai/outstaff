import type { ContextWhy } from "@outstaff/protocol";
import { isOpen } from "#/workstate/open.js";
import type { ContextGraph, ContextNode } from "./context.types.js";

type NodeType = ContextNode["type"];

const ROLES: ContextWhy["role"][] = [
  "trigger",
  "subject",
  "created",
  "attached",
  "mentioned",
  "inferred",
];

const NODE_TYPES = new Set<string>(["ticket", "pr", "doc", "chat_thread"]);

const keyOf = (n: { type: string; ref: string }) => `${n.type}:${n.ref}`;

const linked = (type: NodeType, ref: string, source: string): ContextNode => ({
  type,
  ref,
  why: { role: "linked", source },
});

/** The item's own references, what woke it first, then what it is about, and so on. */
function seeds(graph: ContextGraph): ContextNode[] {
  return graph.refs
    .filter((r) => NODE_TYPES.has(r.type))
    .map((r, i) => ({ r, i, rank: ROLES.indexOf(r.role) }))
    .toSorted((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ r }) => ({
      type: r.type as NodeType,
      ref: r.ref,
      url: r.url,
      why: { role: r.role, source: r.source, addedAt: r.addedAt },
    }));
}

const chatsVia = (graph: ContextGraph, type: "ticket" | "pr", ref: string) =>
  graph.related
    .filter((c) => c.via.type === type && c.via.ref === ref)
    .map((c) => linked("chat_thread", c.chat, `chat thread of work item ${c.itemId}`));

const NEIGHBOURS: Record<NodeType, (graph: ContextGraph, ref: string) => ContextNode[]> = {
  ticket: (graph, ref) => [
    ...graph.prs
      .filter((p) => p.ticket === ref)
      .map((p) => linked("pr", p.ref, `implements ${ref}`)),
    ...graph.docs
      .filter((d) => d.ticket === ref)
      .map((d) => linked("doc", d.id, `written for ${ref}`)),
    ...chatsVia(graph, "ticket", ref),
  ],
  pr: (graph, ref) => {
    const pr = graph.prs.find((p) => p.ref === ref);
    return [
      ...(pr?.ticket ? [linked("ticket", pr.ticket, `implemented by ${ref}`)] : []),
      ...(pr?.stackedOn ? [linked("pr", pr.stackedOn, `${ref} is stacked on it`)] : []),
      ...graph.prs
        .filter((p) => p.stackedOn === ref && isOpen(p))
        .map((p) => linked("pr", p.ref, `stacked on ${ref}`)),
      ...chatsVia(graph, "pr", ref),
    ];
  },
  doc: (graph, ref) => {
    const ticket = graph.docs.find((d) => d.id === ref)?.ticket;
    return ticket ? [linked("ticket", ticket, `${ref} was written for it`)] : [];
  },
  chat_thread: () => [],
};

/**
 * Every item the work is linked to, closest first: the item's own references by role, then what they link to (a
 * ticket's pull requests and documents, a pull request's ticket and stack, the chat threads other work on them came
 * from), breadth first. Each item once, with the first reason found for it.
 */
export function walkGraph(graph: ContextGraph): ContextNode[] {
  const out: ContextNode[] = [];
  const seen = new Set<string>();
  const queue = seeds(graph);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!seen.has(keyOf(node))) {
      seen.add(keyOf(node));
      out.push(node);
      queue.push(...NEIGHBOURS[node.type](graph, node.ref));
    }
  }

  return out;
}

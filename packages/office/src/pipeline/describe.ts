import { subjectLabel } from "#/log.js";
import type { ActOp, Decision, Notify } from "./decisions.types.js";
import type { ErrorProposal, PipelineEvent, Proposal } from "@outstaff/policy";
import type { ContextManifest, ManifestEntry, MergeManifest } from "./context/context.types.js";
import type { Trace } from "./trace.types.js";

/** Each kind of tracker change, in words. */
const OP_TEXT: { [K in ActOp["op"]]: (op: Extract<ActOp, { op: K }>) => string } = {
  move: (op) => `move ${op.ticket} to ${op.to}`,
  assign: (op) =>
    op.to ? `assign ${op.ticket} to ${op.to.kind} ${op.to.id}` : `unassign ${op.ticket}`,
  comment: (op) => `comment on ${"ticket" in op.on ? op.on.ticket : `doc ${op.on.doc}`}`,
  set_parent: (op) => `set the parent of ${op.ticket} to ${op.parent}`,
  link_pr: (op) => `link ${op.pr.repo.owner}/${op.pr.repo.name}#${op.pr.number} on ${op.ticket}`,
  link_doc: (op) => `link doc ${op.doc} on ${op.ticket}`,
  set_field: (op) => `set ${op.field} of ${op.ticket} to ${op.value ?? "nothing"}`,
  chat_dm: (op) => `send a direct message to ${op.to}`,
};

/** One tracker change, in words. */
export function describeOp(op: ActOp): string {
  return (OP_TEXT[op.op] as (o: ActOp) => string)(op);
}

/** What an event is about, in words: a pull request, ticket, document or chat channel. */
export function subjectOf(event: PipelineEvent): string {
  const { chat } = event.subject;
  if (chat && !event.subject.pr && !event.subject.ticket && !event.subject.doc) {
    return `chat ${chat.channel}${chat.thread ? `/${chat.thread}` : ""}`;
  }

  return subjectLabel(event.subject);
}

/** A notice in words: who tells whom, about what. */
export function notifyText(n: Pick<Notify, "as" | "human" | "need" | "ticket" | "prs" | "told">) {
  const of = n.ticket ? ` of ${n.ticket}` : "";
  const prs = n.prs?.length ? ` with ${n.prs.map((p) => p.ref).join(", ")}` : "";
  return n.told
    ? `notify ${n.human} of nothing more${of}: told in the chat thread the work came from`
    : `notify ${n.human} in chat, as ${n.as} (${n.need})${of}${prs}`;
}

/** A stop in words: the ticket, and the agents whose work it leaves alone. */
const stopText = (ticket: string, except: readonly string[] = []) =>
  `stop the work on ${ticket}${except.length > 0 ? `, except ${except.join(", ")}'s` : ""}`;

/** One line per decision, for `ost explain` and the replay report. */
export function describeDecision(d: Decision): string {
  switch (d.type) {
    case "wake":
      return `wake ${d.person} (${d.kind}) on ${d.subject.type} ${d.subject.ref}`;
    case "act":
      return `act for ${d.as}: ${d.ops.map(describeOp).join(", ")}`;
    case "drop":
      return `drop: ${d.reason}`;
    case "stop":
      return stopText(d.ticket, d.except);
    case "notify":
      return notifyText(d);
  }
}

/** One proposal of a policy, in words. */
export function describeProposal(p: Proposal | ErrorProposal): string {
  switch (p.type) {
    case "wake":
      return `wake ${p.person} (${p.kind})${p.subject ? ` on ${p.subject.type} ${p.subject.ref}` : ""}`;
    case "act":
      return `act for ${p.as}: ${p.ops.map(describeOp).join(", ")}`;
    case "suppress":
      return `suppress waking ${p.person}${p.kind ? ` (${p.kind})` : ""}: ${p.reason}`;
    case "stop":
      return stopText(p.ticket, p.except);
    case "notify":
      return notifyText(p);
    default:
      return `${p.type}: ${p.reason}`;
  }
}

/** The policies that listen to the event, each with why it matched or not and what it proposed. */
function policyLines(judged: Trace["policies"]): string[] {
  if (judged.length === 0) {
    return [];
  }

  return [
    "Policies:",
    ...judged.flatMap((p) => [
      `  ${p.matched ? "matched" : "no     "}  ${p.policy}: ${p.reason}`,
      ...(p.failed ? [`           failing condition: ${JSON.stringify(p.failed)}`] : []),
      ...(p.proposals ?? []).map((d) => `           -> ${describeProposal(d)}`),
    ]),
    "",
  ];
}

/** What the aggregation made of each proposal, when it did more than keep them all; a trace may record none. */
function aggregationLines(entries: Trace["aggregation"] = []): string[] {
  if (entries.every((e) => e.outcome === "kept" && !e.reason)) {
    return [];
  }

  return [
    "Aggregation:",
    ...entries.map((e) => {
      const why = e.reason ? `: ${e.reason}` : "";
      const into = e.decision === undefined ? "" : ` (decision ${e.decision + 1})`;
      return `  ${e.policy} #${e.proposal + 1}: ${e.outcome}${why}${into}`;
    }),
    "",
  ];
}

/** A wake's instruction, and the item it queued or was folded into, with that item's events. */
function wakeLines(d: Extract<Decision, { type: "wake" }>): string[] {
  const item = d.folded
    ? [`    folded into work item ${d.itemId}, with the events ${d.folded.join(", ")}`]
    : d.itemId
      ? [`    queued work item ${d.itemId}`]
      : [];

  return [`    instruction: ${d.instruction}`, ...item];
}

/** A stop's notice, and the items it canceled and the notice rounds it queued. */
function stopLines(d: Extract<Decision, { type: "stop" }>): string[] {
  return [
    `    notice: ${d.notice}`,
    ...(d.canceled?.length ? [`    canceled work items ${d.canceled.join(", ")}`] : []),
    ...(d.noticed?.length ? [`    queued notice rounds ${d.noticed.join(", ")}`] : []),
  ];
}

const extraLines = (d: Decision): string[] =>
  d.type === "wake" ? wakeLines(d) : d.type === "stop" ? stopLines(d) : [];

const decisionLines = (decisions: Trace["decisions"]): string[] =>
  decisions.flatMap((d) => [`  ${describeDecision(d)}`, ...extraLines(d)]);

function entryLine(e: ManifestEntry): string {
  const counted =
    e.shown === undefined ? "" : `, ${e.shown} shown${e.left ? `, ${e.left} left out` : ""}`;

  const reviews = e.reviews
    ? `, ${e.reviews.shown} review comment${e.reviews.shown === 1 ? "" : "s"}${e.reviews.left ? `, ${e.reviews.left} left out` : ""}`
    : "";

  return `    ${e.type} ${e.ref} (${e.why.role}: ${e.why.source}${counted}${reviews})${e.url ? ` ${e.url}` : ""}`;
}

/** What a merge's context named. */
function mergeLines(m: MergeManifest | undefined): string[] {
  if (!m) {
    return [];
  }

  const others = m.others.map((o) => `${o.ref} (${o.relation.join(", ") || "unrelated"})`);
  return [
    `    merge of ${m.pr}: base ${m.base.ref} CI ${m.base.ci}`,
    `    other open pull requests: ${others.join(", ") || "none"}${m.moreOthers ? `, ${m.moreOthers} more` : ""}`,
    `    recent merges into ${m.base.ref}: ${m.recentMerges.join(", ") || "none"}`,
  ];
}

/** What each wake the event started was handed, item by item. */
function contextLines(context: Trace["context"]): string[] {
  const manifests: ContextManifest[] = Object.values(context ?? {});
  if (manifests.length === 0) {
    return [];
  }

  return [
    "",
    "Context handed over:",
    ...manifests.flatMap((m) => [
      `  work item ${m.itemId}: ${m.entries.length} linked${m.omitted ? `, ${m.omitted} left out by pipeline.context.items` : ""}`,
      ...m.entries.map(entryLine),
      ...mergeLines(m.merge),
    ]),
  ];
}

/**
 * A trace as text: the event, each policy that listens to it with why it matched or not and what it proposed, what the
 * aggregation did with the proposals, and the decisions.
 */
export function formatTrace(trace: Trace): string {
  const { event } = trace;
  const deaf = trace.policies.filter((p) => !p.matched && p.reason.startsWith("listens to "));
  const judged = trace.policies.filter((p) => !deaf.includes(p));
  return [
    `${event.type} on ${subjectOf(event)} by ${event.actor.kind} ${event.actor.id} at ${event.at}`,
    `event ${event.id}`,
    "",
    ...policyLines(judged),
    ...(deaf.length > 0
      ? [`Not listening to ${event.type}: ${deaf.map((p) => p.policy).join(", ")}`, ""]
      : []),
    ...aggregationLines(trace.aggregation),
    "Decisions:",
    ...decisionLines(trace.decisions),
    ...contextLines(trace.context),
  ].join("\n");
}

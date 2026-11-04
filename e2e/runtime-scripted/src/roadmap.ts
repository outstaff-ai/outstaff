import type { ItemContext } from "./prompt.js";
import type { Action, Script } from "./scripts.js";

/** The plan section of a new feature: its breakdown says which piece can start now and which waits for what. */
export const PLAN_PATH = "plans/resource-monitoring.md";
export const PIECE_NOW = "Collect resource metrics on the server";
export const PIECE_LATER = "Show the history in the dashboard";

/** The roadmap the PM keeps; its line for the proposed milestone is what a human confirms. */
export const ROADMAP_PATH = "roadmap.md";

const planText = (feature: string) =>
  [
    `# Plan: ${feature}`,
    "",
    "## Breakdown",
    "",
    `- now: ${PIECE_NOW}`,
    `- after the dashboard exists: ${PIECE_LATER}`,
    "",
    "## Open decisions",
    "",
    "- Where the history is kept: Postgres (recommended) or a time-series store.",
    "",
  ].join("\n");

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The prompt does not say ${what}.`);
  }

  return value;
}

const urlOf = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

/** The milestone `ost milestone list` lists with this title: its id. */
function milestoneNamed(listed: string, title: string): string {
  const id = new RegExp(`^- (\\S+) \\[\\w+\\] ${title}:`, "m").exec(listed)?.[1];
  return need(id, `the milestone ${title}`);
}

/**
 * A ticket to plan a new feature, filed from chat: the agent writes the plan section, with its breakdown and open
 * decision, and asks the PM where it fits on the roadmap. The item waits for the answer. Once it is in, the agent
 * files nothing more: it says on the ticket where the feature went and hands the plan back for review.
 */
export async function* planFeature(ctx: ItemContext, key: string, feature: string): Script {
  if (ctx.answer) {
    yield {
      type: "tool",
      tool: "ticket_comment",
      input: { key, body: `The PM placed it: ${ctx.answer} No build tickets until then.` },
    };

    yield { type: "tool", tool: "ticket_move", input: { key, to: "review" } };
    return `Placed by the PM: ${ctx.answer}`;
  }

  const written = yield {
    type: "tool",
    tool: "doc_create",
    input: { path: PLAN_PATH, title: `Plan: ${feature}`, body: planText(feature) },
  };

  yield {
    type: "tool",
    tool: "ask",
    input: {
      to: "pm",
      question: `Where does ${key} fit on the roadmap? Its plan: ${PLAN_PATH} (${urlOf(written)}).`,
    },
  };

  return `Wrote the plan ${urlOf(written)} and asked the PM where it fits.`;
}

/**
 * The PM is asked where a new feature fits. This one is not in the current milestone's scope, so it goes in the
 * planned milestone named in the roadmap: its plan is linked to that milestone, and the answer says it is later.
 */
export async function* placeFeature(ctx: ItemContext): Script {
  const question = need(ctx.question, "the question");
  const plan = need(/Its plan: (\S+)/.exec(question.text)?.[1], "the plan");
  const listed = yield { type: "tool", tool: "milestone_list", input: { status: ["planned"] } };
  const later = milestoneNamed(listed, "Monitoring");
  yield { type: "tool", tool: "milestone_add", input: { id: later, doc: plan } };
  const answer = `Later: milestone Monitoring (${later}), after Foundations. Its plan is linked there.`;
  yield { type: "tool", tool: "question_answer", input: { question: question.id, answer } };
  return answer;
}

/**
 * The last open ticket of a milestone closed: the PM checks it, closes it, proposes the next one in the roadmap and
 * asks a human, on the closed ticket, to confirm it on the roadmap.
 */
export async function* milestoneDone(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const done = need(ctx.milestone, "the milestone");
  yield { type: "tool", tool: "milestone_show", input: { id: done.id } };
  yield { type: "tool", tool: "milestone_status", input: { id: done.id, to: "done" } };
  const listed = yield { type: "tool", tool: "milestone_list", input: { status: ["planned"] } };
  const next = need(/^- \S+ \[planned\] (.+?):/m.exec(listed)?.[1], "the next milestone");
  const roadmap = yield {
    type: "tool",
    tool: "doc_create",
    input: {
      path: ROADMAP_PATH,
      title: "Roadmap",
      body: `# Roadmap\n\n1. ${done.title}: done.\n2. ${next}: proposed next.\n`,
    },
  };

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `${done.title} is done. Proposed next: ${next}. Please confirm it on the roadmap: ${urlOf(roadmap)}`,
    },
  };

  return `Closed ${done.title} and proposed ${next}; waiting for a human to confirm.`;
}

/** The pieces of a plan that can start now, from its breakdown; a piece that waits for something stays in the plan. */
const readyPieces = (plan: string) => [...plan.matchAll(/^- now: (.+)$/gm)].map((m) => m[1]!);

/**
 * A human confirmed the next milestone on the roadmap: the PM starts it and files the tickets of its plans whose
 * prerequisites exist, each in the milestone, then answers the comment and resolves it.
 */
export async function* startMilestone(
  ctx: ItemContext,
  doc: string,
  comment: string,
  title: string,
): AsyncGenerator<Action, string, string> {
  const listed = yield { type: "tool", tool: "milestone_list", input: {} };
  const id = milestoneNamed(listed, title);
  yield { type: "tool", tool: "milestone_status", input: { id, to: "active" } };
  const shown = yield { type: "tool", tool: "milestone_show", input: { id } };
  const plans = [...shown.matchAll(/^- .+?: \S*\/docs\/(\d+)/gm)].map((m) => m[1]!);
  const filed: string[] = [];
  for (const plan of plans) {
    const text = yield { type: "tool", tool: "doc_show", input: { id: plan } };
    for (const piece of readyPieces(text)) {
      const made = yield {
        type: "tool",
        tool: "ticket_create",
        input: { title: piece, body: `From the plan ${urlOf(text)}.`, milestone: id },
      };

      filed.push(need(/^Created (\S+?)\./m.exec(made)?.[1], "the new ticket"));
    }
  }

  yield {
    type: "tool",
    tool: "doc_update",
    input: { id: doc, body: `# Roadmap\n\n1. Foundations: done.\n2. ${title}: active.\n` },
  };

  yield {
    type: "tool",
    tool: "doc_reply",
    input: { doc, commentId: comment, body: `Started ${title}; filed ${filed.join(", ")}.` },
  };

  yield { type: "tool", tool: "doc_resolve", input: { doc, commentId: comment } };
  return `Started ${title} (${ctx.itemId}); filed ${filed.join(", ")}.`;
}

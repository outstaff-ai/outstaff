import type { ItemContext } from "./prompt.js";
import type { Action, Script } from "./scripts.js";

/** The gate a decision round waits at after asking the PM, so the answer and a human's message arrive while it runs. */
export const DECIDE_GATE = "decide";

/** A ticket titled `Decide with the PM: <what>`: the round asks the PM; the decision is made once the answer is in. */
export const decideTopic = (key: string, shown: string) =>
  new RegExp(`^${key}: Decide with the PM: (.+)$`, "m").exec(shown)?.[1];

/**
 * A decision to make with the PM. The first round asks the PM and keeps running at the gate until the driver opens
 * it; it is handed back waiting, for the answer. The round that has the answer writes the decision on the ticket, with
 * what the requester said in chat meanwhile, and hands the ticket back for review.
 */
export async function* decideWithPm(ctx: ItemContext, key: string, topic: string): Script {
  if (!ctx.answer) {
    yield {
      type: "tool",
      tool: "ask",
      input: { to: "pm", question: `What do we pick for ${topic}?` },
    };

    yield { type: "gate", name: DECIDE_GATE };
    return `Asked the PM about ${topic}; waiting for the answer.`;
  }

  const said = ctx.feedback.filter((f) => f.kind === "chat").map((f) => f.body);
  const decision = [`Decided with the PM: ${ctx.answer}`, ...said.map((s) => `Requester: ${s}`)];
  yield { type: "tool", tool: "ticket_comment", input: { key, body: decision.join("\n") } };
  yield { type: "tool", tool: "ticket_move", input: { key, to: "review" } };
  return `Decided ${topic}: ${ctx.answer}`;
}

/** The PM's answer to a teammate's question that is not about the roadmap. */
export async function* answerTeammate(ctx: ItemContext): Script {
  const id = ctx.question?.id;
  if (!id) {
    throw new Error("The prompt does not say the question.");
  }

  const answer = "The smallest option that works; we revisit it next milestone.";
  yield { type: "tool", tool: "question_answer", input: { question: id, answer } };
  return answer;
}

/**
 * A chat message `ping <whom>: <message>`: the chat session asks them through the office and replies at once, without
 * waiting for the answer.
 */
async function* pingInChat(latest: string): AsyncGenerator<Action, string | undefined, string> {
  const ping = /^ping (\S+): (.+)$/.exec(latest);
  if (!ping) {
    return undefined;
  }

  const asked = yield { type: "tool", tool: "ask", input: { to: ping[1]!, question: ping[2]! } };
  return `Asked ${/^Asked (\S+);/.exec(asked)?.[1] ?? ping[1]}; I'll pass on the answer here.`;
}

/**
 * The chat round that the answer to a chat session's question starts (the office titles it `Answer from <whom>: ...`):
 * it passes the answer on in the thread.
 */
const passOnAnswer = (ctx: ItemContext) =>
  ctx.kind === "chat" && ctx.title.startsWith("Answer from ") && ctx.answer
    ? `The answer: ${ctx.answer}`
    : undefined;

/** A chat session that pings a teammate, or the round that passes on their answer; undefined for any other message. */
export async function* teammateInChat(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  return passOnAnswer(ctx) ?? (yield* pingInChat(latest));
}

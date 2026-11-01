import { mentionedBy } from "./evaluate-check.js";
import type { Ctx, Resolved } from "./evaluate.types.js";

const agent = (id: string | undefined, skip: string): Resolved<string> =>
  id ? { value: id } : { skip };

/** The people a policy can name, other than `role:<role>`. */
const PEOPLE = new Map<string, (ctx: Ctx) => Resolved<string>>([
  [
    "author",
    (ctx) =>
      agent(
        ctx.pr?.author.kind === "agent" ? ctx.pr.author.person : undefined,
        "pull request has no agent author",
      ),
  ],
  [
    "last_worker",
    (ctx) =>
      agent(
        ctx.ticket ? ctx.state.lastWorker(ctx.ticket) : undefined,
        "no agent has worked on the ticket yet",
      ),
  ],
  [
    "blocked_agent",
    (ctx) =>
      agent(
        ctx.ticket ? ctx.state.blockedAgent(ctx.ticket) : undefined,
        "no agent is blocked on the ticket",
      ),
  ],
  ["mentioned", (ctx) => agent(mentionedBy(ctx.event)[0], "the comment mentions no agent")],
  [
    "doc_author",
    (ctx) => {
      const doc = ctx.event.subject.doc;
      return agent(
        doc ? ctx.state.docAuthor(doc) : undefined,
        "no agent is recorded as the author of the document",
      );
    },
  ],
  [
    "assignee",
    (ctx) => {
      const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
      return a?.kind === "agent" ? { value: a.id } : { skip: "ticket is not assigned to an agent" };
    },
  ],
]);

/**
 * The agent a reference names (`author`, `assignee`, `mentioned`, `last_worker`, `blocked_agent`, `doc_author`,
 * `role:<role>`), or why there is none.
 */
export function person(spec: string, ctx: Ctx): Resolved<string> {
  const named = PEOPLE.get(spec);
  if (named) {
    return named(ctx);
  }

  return agent(ctx.state.personForRole(spec.slice(5)), `no agent plays ${spec}`);
}

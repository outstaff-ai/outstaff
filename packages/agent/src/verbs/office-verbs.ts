import { PortError } from "@outstaff/core";
import { formatWorkGroups, groupWork } from "@outstaff/protocol";
import { z } from "zod";
import { requireOffice } from "./support.js";
import { defineVerb, result } from "./types.js";

export const ask = defineVerb({
  name: "ask",
  summary: "Ask a teammate, or anyone with a role, a question through the office.",
  description:
    "Asks a person of the team by handle, or a role (the least busy person with it answers; your own role means a peer). The office routes it; the answer may come later, as a new message in your work item. A role nobody has gets an explicit reply: ask a human.",
  input: z.strictObject({
    to: z.string().min(1).max(30).describe("Handle of a teammate, or a role such as architect."),
    question: z
      .string()
      .min(1)
      .max(10_000)
      .describe("The question, with enough context to answer it."),
  }),
  args: ["to", "question"],
  examples: [
    'ost ask mira "Should the cart survive a deploy?"',
    'ost ask architect "Should the cart survive a deploy?"',
  ],
  async run(env, input, ctx) {
    if (input.to === env.person) {
      throw new PortError("invalid", "You cannot ask yourself.");
    }

    // Roles and handles are resolved by the office, which knows the live team and says so when nobody fits.
    const office = requireOffice(env);
    const r = await office.ask({
      to: input.to,
      question: input.question,
      ...(ctx.workItemId ? { workItemId: ctx.workItemId } : {}),
    });

    return result(
      [
        r.status === "answered"
          ? `${r.to} answered: ${r.answer ?? ""}`
          : `Asked ${r.to}; no answer yet (question ${r.id}). The answer will arrive in your work item.`,
      ],
      r,
      [],
    );
  },
});

export const answer = defineVerb({
  name: "question.answer",
  cli: ["answer"],
  summary: "Answer a question a teammate asked you.",
  description:
    "Answers a question that the office gave you as a work item. The asker continues their work with your answer. Only the person who was asked can answer, once.",
  input: z.strictObject({
    question: z.string().min(1).describe("Id of the question, from the work item."),
    answer: z.string().min(1).max(10_000).describe("The answer, complete enough to act on."),
  }),
  args: ["question", "answer"],
  examples: ['ost answer 01J9X "Use the fast queue; orders must not wait on mail."'],
  async run(env, input) {
    await requireOffice(env).answer(input.question, input.answer);
    return result([`Answered question ${input.question}.`], { question: input.question }, []);
  },
});

export const work = defineVerb({
  name: "work",
  cli: ["work", "list"],
  summary: "List your work items.",
  description:
    "Lists the work the office has scheduled for you, one numbered line per ticket (or pull request without one) with the follow-ups on it, and under each line its work items with their ids.",
  input: z.strictObject({}),
  args: [],
  examples: ["ost work list"],
  async run(env, _input, ctx) {
    const items = await requireOffice(env).work(
      ctx.workItemId ? { workItemId: ctx.workItemId } : {},
    );

    const ticketUrl = (key: string) => (env.tracker ? env.tracker.links.issue(key) : undefined);
    const groups = groupWork(items);
    const lines = formatWorkGroups(groups, ticketUrl).flatMap((line, n) => [
      line,
      ...groups[n]!.items.map(
        (i) => `   ${i.current ? "*" : "-"} ${i.id} [${i.status}] ${i.title}`,
      ),
    ]);

    const rows = items.map((i) => ({ ...i, ticketUrl: i.ticketKey && ticketUrl(i.ticketKey) }));
    return result(
      lines.length ? lines : ["No work items."],
      { items: rows },
      rows.flatMap((i) => [i.ticketUrl, i.prUrl].filter((u): u is string => !!u)),
    );
  },
});

export const workMove = defineVerb({
  name: "work.move",
  summary: "Put one of your queued work items at a place in your queue.",
  description:
    "Moves a queued work item of yours: next (ahead of the other queued items), last, or before or after another queued item. A running item is never interrupted. Use it when a human tells you where a chat request goes.",
  input: z.strictObject({
    id: z.string().min(1).describe("Id of the queued work item."),
    position: z.enum(["next", "last", "before", "after"]).describe("Where it goes."),
    relativeTo: z
      .string()
      .min(1)
      .optional()
      .describe("The queued item it goes before or after; needed for before and after."),
  }),
  args: ["id", "position", "relativeTo"],
  examples: ["ost work move 01J9X next", "ost work move 01J9X after 01J9Y"],
  async run(env, input) {
    const item = await requireOffice(env).place(input.id, {
      position: input.position,
      ...(input.relativeTo ? { relativeTo: input.relativeTo } : {}),
    });

    return result(
      [
        `Work item ${item.id} (${item.title}) goes ${input.position}${input.relativeTo ? ` ${input.relativeTo}` : ""}.`,
      ],
      { item },
      [],
    );
  },
});

export const team = defineVerb({
  name: "team",
  cli: ["roster"],
  summary: "List the team and what everyone is doing.",
  description: "Lists the people of the team with their roles and current status.",
  input: z.strictObject({}),
  args: [],
  examples: ["ost roster"],
  async run(env) {
    const { members, humans } = await requireOffice(env).team();
    const lines = members.length
      ? members.map(
          (m) =>
            `${m.handle} (${m.name}), ${m.title ?? m.role}: ${m.status}${m.current ? `, ${m.current}` : ""}${m.usage ? `, usage ${Math.round(m.usage.utilization * 100)}% of ${m.usage.window}${m.usage.resetsAt ? ` (resets ${m.usage.resetsAt})` : ""}` : ""}`,
        )
      : ["No team members."];

    if (humans.length) {
      lines.push(`Humans: ${humans.map((h) => h.name).join(", ")}`);
    }

    return result(lines, { members, humans }, []);
  },
});

export const officeVerbs = [ask, answer, work, workMove, team];

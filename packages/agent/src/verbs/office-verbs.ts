import { PortError } from "@outstaff/core";
import { z } from "zod";
import { requireOffice } from "./support.js";
import { defineVerb, result } from "./types.js";

export const ask = defineVerb({
  name: "ask",
  summary: "Ask a teammate a question through the office.",
  description:
    "Asks another person of the team a question. The office routes it; the answer may come later, as a new message in your work item.",
  input: z.strictObject({
    to: z.string().min(1).max(30).describe("Handle of the teammate."),
    question: z
      .string()
      .min(1)
      .max(10_000)
      .describe("The question, with enough context to answer it."),
  }),
  args: ["to", "question"],
  examples: ['ost ask mira "Should the cart survive a deploy?"'],
  async run(env, input, ctx) {
    if (input.to === env.person) {
      throw new PortError("invalid", "You cannot ask yourself.");
    }

    if (!env.team.people.some((p) => p.handle === input.to)) {
      throw new PortError("not_found", `${input.to} is not a person of this team.`);
    }

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

export const work = defineVerb({
  name: "work",
  summary: "List your work items.",
  description:
    "Lists the work items the office has scheduled for you, with their tickets and pull requests.",
  input: z.strictObject({}),
  args: [],
  examples: ["ost work"],
  async run(env, _input, ctx) {
    const items = await requireOffice(env).work(
      ctx.workItemId ? { workItemId: ctx.workItemId } : {},
    );

    const link = (key?: string) => (key && env.tracker ? env.tracker.links.issue(key) : undefined);
    const rows = items.map((i) => ({ ...i, ticketUrl: link(i.ticketKey) }));
    const lines = rows.flatMap((i) => [
      `${i.current ? "* " : "- "}${i.id} [${i.status}] ${i.title}`,
      ...(i.ticketUrl ? [`  ${i.ticketUrl}`] : []),
      ...(i.prUrl ? [`  ${i.prUrl}`] : []),
    ]);

    return result(
      lines.length ? lines : ["No work items."],
      { items: rows },
      rows.flatMap((i) => [i.ticketUrl, i.prUrl].filter((u): u is string => !!u)),
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
    const members = await requireOffice(env).team();
    return result(
      members.length
        ? members.map(
            (m) =>
              `${m.handle} (${m.name}), ${m.role}: ${m.status}${m.current ? `, ${m.current}` : ""}`,
          )
        : ["No team members."],
      { members },
      [],
    );
  },
});

export const officeVerbs = [ask, work, team];

import { PortError } from "@outstaff/core";
import { formatWorkGroups, groupWork } from "@outstaff/protocol";
import { z } from "zod";
import { uploadAttachments, uploadedLines } from "./attachments.js";
import type { Uploaded } from "./types.js";
import { filedLine, requireOffice } from "./support.js";
import { defineVerb, result } from "./define.js";

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

export const workQueue = defineVerb({
  name: "work.queue",
  summary: "File a chat request as work when there is no tracker.",
  description:
    "Files the request of a chat session as a work item of yours. Use it for a message that is work on a team without a tracker (with a tracker, create a ticket). The requester is told, and when you are busy they are asked where it goes. A chat session files one request. A question is answered directly: file nothing.",
  input: z.strictObject({
    title: z.string().min(1).max(300).describe("Short title of the work."),
    body: z.string().max(20_000).default("").describe("What is asked and why, Markdown."),
  }),
  args: ["title", "body"],
  examples: ['ost work queue "Add a search page" "Asked by Dana in chat."'],
  async run(env, input, ctx) {
    if (!ctx.workItemId) {
      throw new PortError("invalid", "Only a chat session files work; there is no work item here.");
    }

    const filed = await requireOffice(env).queueWork(ctx.workItemId, {
      title: input.title,
      body: input.body,
    });

    return result([`Queued "${input.title}".`, filedLine(filed)], { filed }, []);
  },
});

export const workAttach = defineVerb({
  name: "work.attach",
  summary: "Add a chat request to work you already have.",
  description:
    "Makes the request of a chat session part of your existing ticket or pull request instead of new work: it becomes a round on that work, carrying the human's message as feedback, and the thread follows it. Only your own work: assigned to you, work you were the last to work on, or a pull request you authored; the ticket is assigned to you again when the work starts. Nothing is asked about its place. A pull request in review is refused unless the requester said in the thread that it belongs there: ask them first, then pass confirmed. Merged or closed pull requests and finished tickets are never reopened, so file a follow-up with a ticket; the exception is an open pull request whose ticket was closed early (done), which still takes the request, and the ticket goes back to active when the work starts. The files the requester shared in their message are attached to the ticket, when the tracker takes attachments.",
  input: z.strictObject({
    target: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "A ticket key (ACME-11), or a pull request: its number, #number, owner/repo#number or link.",
      ),
    confirmed: z
      .boolean()
      .default(false)
      .describe(
        "The requester said in the thread that the request belongs to this pull request, which is in review.",
      ),
    request: z
      .string()
      .max(20_000)
      .optional()
      .describe(
        'What to add, when the message of this session is only the human\'s answer (for example "this PR"): restate the request they made earlier in the thread.',
      ),
  }),
  args: ["target"],
  examples: ["ost work attach ACME-11", "ost work attach 11 --confirmed"],
  async run(env, input, ctx) {
    if (!ctx.workItemId) {
      throw new PortError(
        "invalid",
        "Only a chat session attaches a request; there is no work item here.",
      );
    }

    const done = await requireOffice(env).attachWork(ctx.workItemId, {
      target: input.target,
      confirmed: input.confirmed,
      ...(input.request ? { request: input.request } : {}),
    });

    const pr = done.attached.pr;
    const ticket = done.attached.ticket;
    // The files of the message join the ticket the request was added to.
    const uploaded: Uploaded = ticket
      ? await uploadAttachments(env, ticket.ref, env.attachments ?? [])
      : { attached: [], failed: [] };

    return result(
      [
        `Added the request to ${[pr && `PR ${pr.ref}`, ticket?.ref].filter(Boolean).join(" for ")}.`,
        ...uploadedLines(uploaded),
        "It is part of that work now and keeps its place. Finish with a short note.",
      ],
      { attached: done.attached },
      [pr?.url, ticket?.url].filter((u): u is string => !!u),
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

export const officeVerbs = [ask, answer, work, workMove, workQueue, workAttach, team];

import { PortError } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";
import {
  milestoneId,
  milestoneLine,
  requireMilestones,
  STATUSES,
  ticketLine,
} from "./milestone-support.js";
import { requireTracker } from "./support.js";
import { key } from "./ticket-support.js";

const ROADMAP =
  "A milestone is a tracker initiative: a step of the roadmap the PM keeps, with its tickets and its plan documents.";

export const milestoneList = defineVerb({
  name: "milestone.list",
  summary: "List the roadmap's milestones, in order.",
  description: `${ROADMAP} Lists them in the roadmap's order with their status: planned, active, done or canceled. Pass status to list only those.`,
  input: z.strictObject({
    status: z
      .array(z.enum(STATUSES))
      .max(4)
      .optional()
      .describe("Only milestones in these statuses."),
  }),
  args: [],
  examples: ["ost milestone list", "ost milestone list --status active"],
  async run(env, input) {
    const milestones = await requireMilestones(requireTracker(env)).initiatives(
      input.status ? { status: input.status } : {},
    );

    const lines = milestones.length ? milestones.map(milestoneLine) : ["No milestones."];
    return result(
      lines,
      { milestones },
      milestones.map((m) => m.url),
    );
  },
});

export const milestoneShow = defineVerb({
  name: "milestone.show",
  summary: "Show a milestone with its tickets and its documents.",
  description: `${ROADMAP} Shows one: its status and description, every ticket in it with its status, and the documents linked to it (the plans of its later work).`,
  input: z.strictObject({ id: milestoneId }),
  args: ["id"],
  examples: ["ost milestone show 7"],
  async run(env, input) {
    const tracker = requireTracker(env);
    const milestone = await requireMilestones(tracker).getInitiative(input.id);
    const tickets = await tracker.listIssues({ initiative: milestone.id, brief: true });
    const docs = (await env.knowledge?.initiativeDocs?.(milestone.id)) ?? [];
    const docUrl = (id: string) => env.knowledge!.links.doc(id);
    const lines = [
      `${milestone.id}: ${milestone.title} [${milestone.status}]`,
      milestone.url,
      "",
      milestone.description.trim() || "(no description)",
      "",
      `Tickets (${tickets.length}):`,
      ...tickets.map((i) => ticketLine(i, tracker.links.issue(i.key))),
      ...(docs.length
        ? ["", "Documents:", ...docs.map((d) => `- ${d.title}: ${docUrl(d.id)}`)]
        : []),
    ];

    return result(lines, { milestone, tickets, docs }, [milestone.url]);
  },
});

export const milestoneCreate = defineVerb({
  name: "milestone.create",
  summary: "Create a milestone of the roadmap.",
  description: `${ROADMAP} Creates one, planned unless status says otherwise. Its description says its goal and its exit criteria.`,
  input: z.strictObject({
    title: z.string().min(1).max(300).describe("Short title."),
    description: z.string().max(20_000).default("").describe("Goal and exit criteria, Markdown."),
    status: z.enum(STATUSES).default("planned").describe("Where it starts."),
  }),
  args: [],
  examples: [
    'ost milestone create --title "Monitoring" --description "Goal: see resource use over time."',
  ],
  async run(env, input) {
    const made = await requireMilestones(requireTracker(env)).createInitiative(input);
    return result([`Created milestone ${made.id}.`, milestoneLine(made)], { milestone: made }, [
      made.url,
    ]);
  },
});

export const milestoneAdd = defineVerb({
  name: "milestone.add",
  summary: "Put a ticket, or link a plan document, in a milestone.",
  description: `${ROADMAP} Puts a ticket in the milestone (out of any other), or links a document to it: the plan of work that waits for this milestone, with no tickets yet. Pass ticket, doc, or both.`,
  input: z.strictObject({
    id: milestoneId,
    ticket: key.optional().describe("Key of the ticket to put in the milestone."),
    doc: z.string().min(1).max(500).optional().describe("Id or path of a document to link."),
  }),
  args: ["id"],
  examples: [
    "ost milestone add 7 --ticket ACME-31",
    "ost milestone add 8 --doc plans/monitoring.md",
  ],
  async run(env, input) {
    if (!input.ticket && !input.doc) {
      throw new PortError("invalid", "Pass ticket, doc or both.");
    }

    const tracker = requireTracker(env);
    const milestone = await requireMilestones(tracker).getInitiative(input.id);
    const lines = [
      ...(input.ticket ? await addTicket(env, input.ticket, milestone.id) : []),
      ...(input.doc ? await addDoc(env, input.doc, milestone.id) : []),
    ];

    return result([...lines, milestone.url], { milestone }, [milestone.url]);
  },
});

async function addTicket(env: Parameters<typeof requireTracker>[0], ticket: string, id: string) {
  const tracker = requireTracker(env);
  const issue = await requireMilestones(tracker).setInitiative(ticket, id);
  return [`${issue.key} is in milestone ${id}: ${tracker.links.issue(issue.key)}`];
}

async function addDoc(env: Parameters<typeof requireTracker>[0], doc: string, id: string) {
  const knowledge = env.knowledge;
  if (!knowledge?.linkInitiative) {
    throw new PortError("unsupported", "This knowledge base cannot link documents to milestones.");
  }

  const done = await knowledge.linkInitiative(doc, id);
  return [done === "linked" ? `Linked ${doc} to milestone ${id}.` : `${doc} was linked already.`];
}

export const milestoneStatus = defineVerb({
  name: "milestone.status",
  summary: "Start, close or drop a milestone.",
  description: `${ROADMAP} Moves it to planned, active (started), done (closed) or canceled. Start the next one only once a trusted human confirmed it.`,
  input: z.strictObject({ id: milestoneId, to: z.enum(STATUSES).describe("Its new status.") }),
  args: ["id", "to"],
  examples: ["ost milestone status 7 done", "ost milestone status 8 active"],
  async run(env, input) {
    const updated = await requireMilestones(requireTracker(env)).updateInitiative(input.id, {
      status: input.to,
    });

    return result(
      [`Milestone ${updated.id} is ${updated.status}.`, milestoneLine(updated)],
      {
        milestone: updated,
      },
      [updated.url],
    );
  },
});

export const milestoneVerbs = [
  milestoneList,
  milestoneShow,
  milestoneCreate,
  milestoneAdd,
  milestoneStatus,
];

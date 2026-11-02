import {
  CANONICAL_STATUSES,
  type CanonicalStatus,
  type Issue,
  type IssueFilter,
} from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";
import { requireTracker } from "./support.js";
import { key, memberFor, who } from "./ticket-support.js";
import type { AgentEnv } from "./types.js";
import { when } from "./when.js";

/** How many tickets a listing reads, to say how many more there are than it shows. */
const WINDOW = 200;

const OPEN = CANONICAL_STATUSES.filter((s) => s !== "done" && s !== "canceled");

const isStatus = (s: string): s is CanonicalStatus =>
  (CANONICAL_STATUSES as readonly string[]).includes(s);

/** The statuses `--status` names: `open` (all but done and canceled), `all`, or a comma-separated list. */
function statusesOf(value: string): CanonicalStatus[] | undefined {
  const v = value.trim().toLowerCase();
  if (v === "all") {
    return undefined;
  }

  if (v === "open") {
    return OPEN;
  }

  return v.split(",").map((s) => s.trim()) as CanonicalStatus[];
}

const statusInput = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      ["open", "all"].includes(v.trim().toLowerCase()) ||
      v.split(",").every((s) => isStatus(s.trim().toLowerCase())),
    `Use open, all, or canonical statuses separated by commas (${CANONICAL_STATUSES.join(", ")}).`,
  );

async function assigneeOf(env: AgentEnv, value: string): Promise<string | null> {
  if (value.toLowerCase() === "unassigned") {
    return null;
  }

  return (await memberFor(env, requireTracker(env), value)).id;
}

const line = (i: Issue, url: string, now: Date) =>
  `- ${i.key} (${i.status.canonical ?? i.status.name}) ${i.title} · ${who(i.assignee)} · updated ${when(i.updatedAt, now)} · ${url}`;

const listInput = z.strictObject({
  status: statusInput
    .default("open")
    .describe(
      "open (every status but done and canceled), all, or canonical statuses separated by commas, for example review,blocked.",
    ),
  assignee: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('"me", "unassigned", or a tracker member\'s username, name or id.'),
  label: z.string().min(1).max(200).optional().describe("Only tickets with this label."),
  parent: key.optional().describe("Only the subtasks of this ticket."),
  since: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => !Number.isNaN(Date.parse(v)), "Pass a time such as 2026-01-31T09:00:00Z.")
    .optional()
    .describe("Only tickets updated at or after this time (ISO-8601)."),
  limit: z.number().int().min(1).max(100).default(25).describe("How many tickets to show."),
});

type ListInput = z.output<typeof listInput>;

/** The tracker filter of the input: everything it asks for, read in one window. */
async function filterOf(env: AgentEnv, input: ListInput): Promise<IssueFilter> {
  const status = statusesOf(input.status);
  return {
    ...(status ? { status } : {}),
    ...(input.assignee ? { assignee: await assigneeOf(env, input.assignee) } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.parent ? { parent: input.parent } : {}),
    ...(input.since ? { updatedSince: new Date(input.since).toISOString() } : {}),
    limit: WINDOW,
    brief: true,
  };
}

/** The filters of the input in words. */
const described = (input: ListInput) =>
  [
    `status ${input.status}`,
    input.assignee && `assignee ${input.assignee}`,
    input.label && `label ${input.label}`,
    input.parent && `parent ${input.parent}`,
    input.since && `updated since ${input.since}`,
  ]
    .filter(Boolean)
    .join(", ");

/** What the listing leaves out; nothing when it shows every match. A full window may hide more still. */
function moreLines(found: number, shown: number): string[] {
  const more = found - shown;
  if (more <= 0) {
    return [];
  }

  const count = found >= WINDOW ? `at least ${more}` : String(more);
  return [
    `…and ${count} more. Narrow it with --status, --assignee, --label, --parent or --since, or raise --limit.`,
  ];
}

export const ticketList = defineVerb({
  name: "ticket.list",
  summary: "List tickets by status, assignee, label, parent or last update.",
  description:
    "Lists tickets as the tracker has them now, most recently updated first: key, title, canonical status, assignee, when it was last updated, and the URL. Default: open tickets (every status but done and canceled). Use it to answer what is open, blocked or done from the current state rather than from earlier messages.",
  input: listInput,
  args: [],
  examples: [
    "ost ticket list",
    "ost ticket list --status blocked --assignee me",
    "ost ticket list --status done --since 2026-01-31T00:00:00Z",
    "ost ticket list --parent ACME-10 --status all",
  ],
  async run(env, input) {
    const tracker = requireTracker(env);
    const found = await tracker.listIssues(await filterOf(env, input));
    const shown = found.slice(0, input.limit);
    const now = env.now?.() ?? new Date();
    const urls = shown.map((i) => tracker.links.issue(i.key));
    const lines = shown.length
      ? [
          `Tickets (${described(input)}), most recently updated first, as the tracker has them now:`,
          ...shown.map((i, n) => line(i, urls[n]!, now)),
          ...moreLines(found.length, shown.length),
        ]
      : [`No tickets match (${described(input)}).`];

    return result(lines, { issues: shown, more: found.length - shown.length }, urls);
  },
});

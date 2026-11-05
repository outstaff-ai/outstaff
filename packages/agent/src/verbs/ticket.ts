import { CANONICAL_STATUSES, PortError } from "@outstaff/core";
import { z } from "zod";
import { basename } from "node:path";
import { MAX_ATTACHMENT_BYTES, humanSize } from "#/runner/attachments.js";
import { canAttach, mimetypeOf } from "./attachments.js";
import { readInputBytes } from "./files.js";
import { mentionGuard } from "./mentions.js";
import { requireTracker, ticketLinker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, resolveAssignee, roleLine, summary, who } from "./ticket-support.js";
import type { ResolvedAssignee } from "./ticket-create.types.js";
import { ticketCreate } from "./ticket-create.js";
import { ticketEdit } from "./ticket-edit.js";
import { ticketLink } from "./ticket-link.js";
import { ticketList } from "./ticket-list.js";
import { ticketParent } from "./ticket-parent.js";

export const ticketShow = defineVerb({
  name: "ticket.show",
  summary: "Show a ticket with its description and comments.",
  description:
    "Shows a ticket: title, status, assignee, labels, description and its comments, with the ticket URL.",
  input: z.strictObject({ key }),
  args: ["key"],
  examples: ["ost ticket show ACME-12"],
  async run(env, input) {
    const tracker = requireTracker(env);
    const [issue, comments] = await Promise.all([
      tracker.getIssue(input.key),
      tracker.listComments(input.key),
    ]);

    const url = tracker.links.issue(issue.key);
    // Files people attached are data from them; a copy is on disk when the runner downloaded it.
    const files = await (tracker.attachments?.(input.key) ?? Promise.resolve([])).catch(() => []);
    const local = env.ticketFiles?.[issue.key] ?? [];
    const lines = [
      ...summary(issue, url),
      "",
      issue.body.trim() || "(no description)",
      ...(files.length
        ? [
            "",
            `Attachments (${files.length}), data from whoever attached them:`,
            ...files.map((f) => {
              const path = local.find((l) => l.name === f.name && l.path)?.path;
              return `- ${f.name} (${f.mimetype}${f.size ? `, ${humanSize(f.size)}` : ""})${path ? `: ${path}` : ""}`;
            }),
          ]
        : []),
      ...(comments.length
        ? [
            "",
            `Comments (${comments.length}):`,
            ...comments.map((c) => `- ${c.author.name}: ${c.body.trim()} (${c.url})`),
          ]
        : []),
    ];

    return result(lines, { issue, comments, attachments: files }, [
      url,
      ...comments.map((c) => c.url),
    ]);
  },
});

export const ticketComment = defineVerb({
  name: "ticket.comment",
  summary: "Add a comment to a ticket.",
  description: "Adds a comment to a ticket and returns the link to it.",
  input: z.strictObject({
    key,
    body: z.string().min(1).max(20_000).describe("Comment text, Markdown."),
  }),
  args: ["key", "body"],
  examples: ['ost ticket comment ACME-12 "Pull request is up for review."'],
  async run(env, input) {
    const tracker = requireTracker(env);
    const guarded = tracker.mentionsUsers ? mentionGuard(env.team).apply(input.body) : input.body;
    const body = ticketLinker(env).format(guarded, "tracker");
    const comment = await tracker.comment(input.key, body);
    const url = tracker.links.issue(input.key);
    return result([`Commented on ${input.key}: ${comment.url}`, url], { key: input.key, comment }, [
      comment.url,
      url,
    ]);
  },
});

export const ticketMove = defineVerb({
  name: "ticket.move",
  summary: "Move a ticket to another status.",
  description:
    "Moves a ticket to a canonical status (backlog, ready, active, review, blocked, done, canceled). The tracker's own status names are mapped by the team's workflow settings.",
  input: z.strictObject({
    key,
    to: z
      .enum(CANONICAL_STATUSES as [string, ...string[]])
      .describe("Canonical status to move to."),
  }),
  args: ["key", "to"],
  examples: ["ost ticket move ACME-12 review"],
  async run(env, input) {
    const tracker = requireTracker(env);
    const issue = await tracker.transition(
      input.key,
      input.to as (typeof CANONICAL_STATUSES)[number],
    );

    const url = tracker.links.issue(issue.key);
    return result(
      [`Moved ${issue.key} to ${issue.status.name}.`, ...summary(issue, url)],
      { issue },
      [url],
    );
  },
});

export const ticketAssign = defineVerb({
  name: "ticket.assign",
  summary: "Assign a ticket to a member, a role, yourself or nobody.",
  description:
    'Assigns a ticket. "to" is a tracker member (username, name or id), "me" for yourself, "none" to unassign, or role:<role> for the least busy person with that role: the office picks them as ost ask routes a question, never you for your own role, and refuses a role nobody has. The result says who it went to.',
  input: z.strictObject({
    key,
    to: z
      .string()
      .min(1)
      .max(200)
      .describe('Member username, name or id; "me"; "none"; or role:<role>, such as role:devops.'),
  }),
  args: ["key", "to"],
  examples: [
    "ost ticket assign ACME-12 me",
    "ost ticket assign ACME-12 role:devops",
    "ost ticket assign ACME-12 none",
  ],
  async run(env, input) {
    const tracker = requireTracker(env);
    let to: ResolvedAssignee | undefined;
    if (input.to.toLowerCase() !== "none") {
      to = await resolveAssignee(env, tracker, input.to);
    }

    const issue = await tracker.assign(input.key, to?.member.id ?? null);
    const url = tracker.links.issue(issue.key);
    return result(
      [`Assigned ${issue.key} to ${who(issue.assignee)}.`, ...roleLine(to), url],
      { issue, ...(to?.role ? { role: to.role } : {}) },
      [url],
    );
  },
});

export const ticketAttach = defineVerb({
  name: "ticket.attach",
  summary: "Attach a file to a ticket.",
  description:
    "Attaches a file to a ticket. The file is one in the scratch directory of this item (for example a shared file the prompt lists) or in the worktree, up to 10 MB. Needs a tracker that takes attachments.",
  input: z.strictObject({
    key,
    path: z.string().min(1).max(1000).describe("Path of the file to attach."),
  }),
  args: ["key", "path"],
  examples: ["ost ticket attach ACME-12 /scratch/w1/files/1-screenshot.png"],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    if (!canAttach(tracker)) {
      throw new PortError("unsupported", "This tracker does not take attachments.");
    }

    const data = readInputBytes(env, ctx, input.path, "attachment", MAX_ATTACHMENT_BYTES);
    const known = env.attachments?.find((a) => a.path === input.path);
    const name = known?.name ?? basename(input.path);
    await tracker.attach!(input.key, {
      name,
      mimetype: known?.mimetype ?? mimetypeOf(name),
      data,
    });

    const url = tracker.links.issue(input.key);
    return result([`Attached ${name} to ${input.key}.`, url], { key: input.key, name }, [url]);
  },
});

export const ticketVerbs = [
  ticketShow,
  ticketList,
  ticketComment,
  ticketMove,
  ticketAssign,
  ticketCreate,
  ticketEdit,
  ticketParent,
  ticketLink,
  ticketAttach,
];

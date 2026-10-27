import { CANONICAL_STATUSES, PortError } from "@outstaff/core";
import { z } from "zod";
import { basename } from "node:path";
import { MAX_ATTACHMENT_BYTES, humanSize } from "#/runner/attachments.js";
import { canAttach, mimetypeOf } from "./attachments.js";
import { readInputBytes } from "./files.js";
import { mentionGuard } from "./mentions.js";
import { requireTracker, ticketLinker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, memberFor, summary, who } from "./ticket-support.js";
import { ticketCreate } from "./ticket-create.js";

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
  summary: "Assign a ticket to a member, to yourself or to nobody.",
  description:
    'Assigns a ticket. "to" is a tracker member (username, name or id), "me" for yourself, or "none" to unassign.',
  input: z.strictObject({
    key,
    to: z.string().min(1).max(200).describe('Member username, name or id; "me"; or "none".'),
  }),
  args: ["key", "to"],
  examples: ["ost ticket assign ACME-12 me", "ost ticket assign ACME-12 none"],
  async run(env, input) {
    const tracker = requireTracker(env);
    let memberId: string | null = null;
    if (input.to.toLowerCase() !== "none") {
      memberId = (await memberFor(env, tracker, input.to)).id;
    }

    const issue = await tracker.assign(input.key, memberId);
    const url = tracker.links.issue(issue.key);
    return result([`Assigned ${issue.key} to ${who(issue.assignee)}.`, url], { issue }, [url]);
  },
});

export const ticketParent = defineVerb({
  name: "ticket.parent",
  summary: "Make a ticket a subtask of another ticket.",
  description:
    "Sets the parent of an existing ticket in the tracker's own parent field, so it shows as a subtask of the parent. Use it for work that is part of another ticket's scope. Refused when the tracker has no parent field; link independent follow-ups with a relates link instead.",
  input: z.strictObject({ key, parent: key.describe("Key of the parent ticket.") }),
  args: ["key", "parent"],
  examples: ["ost ticket parent ACME-120 ACME-118"],
  async run(env, input) {
    const tracker = requireTracker(env);
    if (!tracker.setParent) {
      throw new PortError("unsupported", "This tracker has no parent field.");
    }

    const issue = await tracker.setParent(input.key, input.parent);
    const url = tracker.links.issue(issue.key);
    return result([`${issue.key} is now a subtask of ${input.parent}.`, url], { issue }, [url]);
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
  ticketComment,
  ticketMove,
  ticketAssign,
  ticketCreate,
  ticketParent,
  ticketAttach,
];

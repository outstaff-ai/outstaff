import { CANONICAL_STATUSES, PortError, type Issue, type Member } from "@outstaff/core";
import { z } from "zod";
import { basename } from "node:path";
import { MAX_ATTACHMENT_BYTES, humanSize } from "../runner/attachments.js";
import {
  attachmentsSection,
  canAttach,
  mimetypeOf,
  uploadAttachments,
  uploadedLines,
} from "./attachments.js";
import { readInputBytes } from "./files.js";
import { mentionGuard } from "./mentions.js";
import { filedLine, requireOffice, requireTracker, ticketLinker } from "./support.js";
import { defineVerb, result } from "./types.js";

const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Not a ticket key.")
  .describe("Ticket key, for example ACME-12.");

const who = (m?: Member) => (m ? `${m.name}${m.username ? ` (@${m.username})` : ""}` : "nobody");

const summary = (issue: Issue, url: string) => [
  `${issue.key}: ${issue.title}`,
  `Status: ${issue.status.name}${issue.status.canonical ? ` (${issue.status.canonical})` : ""}`,
  `Assignee: ${who(issue.assignee)}`,
  ...(issue.labels.length ? [`Labels: ${issue.labels.join(", ")}`] : []),
  url,
];

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
      const wanted = (input.to.toLowerCase() === "me" ? env.person : input.to).toLowerCase();
      const members = await tracker.members();
      const hit =
        members.find((m) => m.id.toLowerCase() === wanted) ??
        members.find((m) => m.username?.toLowerCase() === wanted) ??
        members.find((m) => m.name.toLowerCase() === wanted);

      if (!hit) {
        throw new PortError("not_found", `No tracker member matches "${input.to}".`);
      }

      memberId = hit.id;
    }

    const issue = await tracker.assign(input.key, memberId);
    const url = tracker.links.issue(issue.key);
    return result([`Assigned ${issue.key} to ${who(issue.assignee)}.`, url], { issue }, [url]);
  },
});

export const ticketCreate = defineVerb({
  name: "ticket.create",
  summary: "Create a ticket assigned to you.",
  description:
    'Creates a ticket assigned to you. In a chat session, the files the requester shared in their message are attached to the ticket automatically and listed in its description; mention the pictures where they belong in the description you write (for example "see the attached screenshot"). Pass parent to make it a sub-ticket of another ticket: it is linked to the parent and its description starts with a Part of line with the parent\'s link. Use it when the work of a ticket needs several pull requests: split it into sub-tickets, one pull request each. In a chat session, the ticket files the request as work: the office creates the work item for it, the requester is told about it, and when you are busy they are asked where it goes. A chat session files one request. Create a ticket only for a request that is work; answer a question directly.',
  input: z.strictObject({
    title: z.string().min(1).max(300).describe("Short title."),
    body: z.string().max(20_000).default("").describe("What is asked and why, Markdown."),
    status: z
      .enum(["ready", "active"])
      .optional()
      .describe("Where it starts; active when you start now (the default inside a work item)."),
    parent: key
      .optional()
      .describe("Key of the ticket this one is part of; the new ticket is linked to it."),
  }),
  args: [],
  examples: [
    'ost ticket create --title "Add a search page" --body "Asked by Dana in chat."',
    'ost ticket create --parent ACME-12 --title "Add the search index" --body "The index half of ACME-12."',
  ],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    const current = ctx.workItemId
      ? (await requireOffice(env).work({ workItemId: ctx.workItemId })).find(
          (i) => i.id === ctx.workItemId,
        )
      : undefined;

    // A sub-ticket is made from inside the work item of its parent: that is what splitting a ticket is.
    if (current?.ticketKey && !input.parent) {
      throw new PortError(
        "invalid",
        `This work item already has ticket ${current.ticketKey}; use it instead of creating another.`,
      );
    }

    // A chat session files the ticket as work; the work item that does it moves the ticket when it starts.
    const chat = current?.kind === "chat";
    const handle = env.team.people.find((p) => p.handle === env.person)?.identities?.tracker;
    const member = handle
      ? (await tracker.members()).find((m) => m.id === handle || m.username === handle)
      : undefined;

    const parent = input.parent ? await tracker.getIssue(input.parent) : undefined;
    const partOf = parent ? `Part of ${parent.key}: ${tracker.links.issue(parent.key)}` : undefined;

    // The files of the chat message go with the ticket; the body says where they are.
    const files = chat ? (env.attachments ?? []) : [];
    const described = files.length ? attachmentsSection(files, canAttach(tracker)) : "";
    const text = [partOf, input.body, described].filter(Boolean).join("\n\n").trimEnd();
    const issue = await tracker.createIssue({
      title: input.title,
      body: text,
      status: input.status ?? (ctx.workItemId && !chat ? "active" : "ready"),
      ...(member ? { assignee: member.id } : {}),
    });

    // The body line is the link every tracker can show; a tracker that relates tickets gets the relation as well.
    if (parent) {
      await tracker.link(issue.key, parent.key, "relates").catch((error: unknown) => {
        if (!(error instanceof PortError)) {
          throw error;
        }
      });
    }

    const uploaded = await uploadAttachments(env, issue.key, files);
    if (uploaded.failed.length) {
      // The body says they are attached; say here that they are not.
      await tracker
        .comment(
          issue.key,
          `These files could not be attached and stayed in chat: ${uploaded.failed.map((f) => f.name).join(", ")}.`,
        )
        .catch(() => {});
    }

    const url = tracker.links.issue(issue.key);
    const filed = chat ? await requireOffice(env).linkTicket(current.id, issue.key) : undefined;
    return result(
      [
        `Created ${issue.key}.`,
        ...summary(issue, url),
        ...uploadedLines(uploaded),
        ...(partOf ? [partOf] : []),
        ...(filed ? [filedLine(filed)] : []),
      ],
      { issue, ...(filed ? { filed } : {}) },
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
  ticketComment,
  ticketMove,
  ticketAssign,
  ticketCreate,
  ticketAttach,
];

import { PortError } from "@outstaff/core";
import { z } from "zod";
import { attachmentsSection, canAttach, uploadAttachments, uploadedLines } from "./attachments.js";
import { filedLine, requireOffice, requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, memberFor, summary } from "./ticket-support.js";

export const ticketCreate = defineVerb({
  name: "ticket.create",
  summary: "Create a ticket; a follow-up goes to the backlog, unassigned.",
  description:
    'Creates a ticket. Inside a work item that has a ticket, it is a follow-up: it lands in the backlog, unassigned, as a sub-ticket of the ticket you are working (pass parent for another one). File what you find while working instead of asking someone else to; name each follow-up in your hand-back. A follow-up that stands on its own, not part of the ticket\'s scope, passes related (the ticket it came from) instead: it is then a separate ticket with a relates link. Pass assignee to give it to someone ("me" for yourself) and status to start it elsewhere; use that for a part of the current ticket you will do yourself. The parent is set in the tracker\'s own parent field where it has one and is otherwise a "relates" link; the description starts with a Part of line with the parent\'s link either way. Use it when the work of a ticket needs several pull requests: split it into sub-tickets, one pull request each. In a chat session, the files the requester shared in their message are attached to the ticket automatically and listed in its description; mention the pictures where they belong in the description you write (for example "see the attached screenshot"). The ticket files the request as work for you: the office creates the work item for it, the requester is told about it, and when you are busy they are asked where it goes. A chat session may file several requests of one message, one ticket each; filing the same request twice is refused before anything is created. Create a ticket only for a request that is work; answer a question directly.',
  input: z.strictObject({
    title: z.string().min(1).max(300).describe("Short title."),
    body: z.string().max(20_000).default("").describe("What is asked and why, Markdown."),
    status: z
      .enum(["backlog", "ready", "active"])
      .optional()
      .describe(
        "Where it starts: backlog (the default), or ready or active when it is to be worked.",
      ),
    parent: key
      .optional()
      .describe(
        "Key of the ticket this one is part of. Defaults to the ticket of the work item you are in.",
      ),
    related: key
      .optional()
      .describe(
        "Key of a ticket this one only relates to: an independent follow-up. It is then not a subtask of the current ticket.",
      ),
    assignee: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Member username, name or id; "me" for yourself. Unassigned when omitted.'),
  }),
  args: [],
  examples: [
    'ost ticket create --title "Add a search index" --body "Part of ACME-48."',
    'ost ticket create --related ACME-48 --title "Rate-limit the search endpoint" --body "Found while reviewing ACME-48."',
    'ost ticket create --parent ACME-12 --title "Add the search index" --assignee me --status active --body "The index half of ACME-12."',
  ],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    const current = ctx.workItemId
      ? (await requireOffice(env).work({ workItemId: ctx.workItemId })).find(
          (i) => i.id === ctx.workItemId,
        )
      : undefined;

    // A chat session files the ticket as work; the work item that does it moves the ticket when it starts.
    const chat = current?.kind === "chat";

    // Every refusal comes before the first write: a ticket the office would then refuse must not exist.
    if (chat) {
      await requireOffice(env).checkFiling(current.id, input.title);
    }

    const parentKey = input.parent ?? (chat || input.related ? undefined : current?.ticketKey);
    const parent = parentKey ? await tracker.getIssue(parentKey) : undefined;
    const partOf = parent ? `Part of ${parent.key}: ${tracker.links.issue(parent.key)}` : undefined;

    // A chat ticket is the chat session's own work; any other ticket belongs to nobody until it is given.
    const handle = env.team.people.find((p) => p.handle === env.person)?.identities?.tracker;
    const assignee = chat
      ? handle
        ? (await tracker.members()).find((m) => m.id === handle || m.username === handle)
        : undefined
      : input.assignee
        ? await memberFor(env, tracker, input.assignee)
        : undefined;

    // The files of the chat message go with the ticket; the body says where they are.
    const files = chat ? (env.attachments ?? []) : [];
    const described = files.length ? attachmentsSection(files, canAttach(tracker)) : "";
    const text = [partOf, input.body, described].filter(Boolean).join("\n\n").trimEnd();
    const created = await tracker.createIssue({
      title: input.title,
      body: text,
      status: input.status ?? (chat ? "ready" : "backlog"),
      ...(assignee ? { assignee: assignee.id } : {}),
      ...(parent && tracker.setParent ? { parent: parent.key } : {}),
    });

    // The real parent went in with the ticket where the tracker has one; otherwise a "relates" link.
    const issue = created;
    let parentLine: string | undefined;
    if (parent && tracker.setParent) {
      parentLine = `Parent: ${parent.key}.`;
    } else if (parent) {
      await tracker.link(issue.key, parent.key, "relates").catch((error: unknown) => {
        if (!(error instanceof PortError)) {
          throw error;
        }
      });

      parentLine = `Related to ${parent.key} (this tracker has no parent field).`;
    }

    if (input.related) {
      await tracker.link(issue.key, input.related, "relates").catch((error: unknown) => {
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
    const filed = chat
      ? await requireOffice(env).linkTicket(current.id, issue.key, input.title)
      : undefined;

    return result(
      [
        `Created ${issue.key}.`,
        ...summary(issue, url),
        ...uploadedLines(uploaded),
        ...(parentLine ? [parentLine] : []),
        ...(filed ? [filedLine(filed)] : []),
        ...(!chat && current ? [`Name ${issue.key} in your hand-back.`] : []),
      ],
      { issue, ...(filed ? { filed } : {}) },
      [url],
    );
  },
});

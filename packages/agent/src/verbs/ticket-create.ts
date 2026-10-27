import { z } from "zod";
import { uploadAttachments, uploadedLines } from "./attachments.js";
import { requireOffice, requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, summary } from "./ticket-support.js";
import {
  assigneeFor,
  chatFiles,
  closingLines,
  currentItem,
  linkParent,
  linkRelated,
  newIssue,
  noteFailedUploads,
  parentIssue,
} from "./ticket-create-steps.js";

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
    const current = await currentItem(env, ctx);

    // A chat session files the ticket as work; the work item that does it moves the ticket when it starts.
    const chat = current?.kind === "chat" ? current : undefined;

    // Every refusal comes before the first write: a ticket the office would then refuse must not exist.
    if (chat) {
      await requireOffice(env).checkFiling(chat.id, input.title);
    }

    const parent = await parentIssue(tracker, input, current, !!chat);
    const assignee = await assigneeFor(env, tracker, input, !!chat);
    const files = chatFiles(env, !!chat);
    const issue = await tracker.createIssue(
      newIssue(tracker, input, { parent, assignee, files, chat: !!chat }),
    );

    const parentLine = await linkParent(tracker, issue.key, parent);
    await linkRelated(tracker, issue.key, input.related);
    const uploaded = await uploadAttachments(env, issue.key, files);
    await noteFailedUploads(tracker, issue.key, uploaded);
    const url = tracker.links.issue(issue.key);
    const filed = chat
      ? await requireOffice(env).linkTicket(chat.id, issue.key, input.title)
      : undefined;

    return result(
      [
        `Created ${issue.key}.`,
        ...summary(issue, url),
        ...uploadedLines(uploaded),
        ...closingLines(issue.key, parentLine, filed, !chat && !!current),
      ],
      { issue, ...(filed ? { filed } : {}) },
      [url],
    );
  },
});

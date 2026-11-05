import { z } from "zod";
import { uploadAttachments, uploadedLines } from "./attachments.js";
import { requireHumanStarted, requireOffice, requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { chatLine, sayInput } from "./chat-line.js";
import { milestoneFor, milestoneId } from "./milestone-support.js";
import { key, summary } from "./ticket-support.js";
import { similarOpenTickets, similarWarning } from "./ticket-similar.js";
import { blockerIssues, linkBlockers, startsBlocked } from "./ticket-create-blockers.js";
import {
  assigneeFor,
  chatFiles,
  closingLines,
  currentItem,
  fileInOffice,
  linkParent,
  linkRelated,
  newIssue,
  noteFailedUploads,
  parentIssue,
  recordMade,
  relatedKey,
} from "./ticket-create-steps.js";

export const ticketCreate = defineVerb({
  name: "ticket.create",
  summary: "Create a ticket; a follow-up goes to the backlog, unassigned, related to your ticket.",
  description:
    'Creates a ticket. Inside a work item that has a ticket, it is a follow-up: it lands in the backlog, unassigned, as a separate ticket with a relates link to the ticket you are working (pass related for another one). A follow-up is never a sub-ticket: work found along the way is not part of the ticket\'s planned scope, and does not hold the ticket open. File what you find while working instead of asking someone else to; name each follow-up in your hand-back. A ticket of the roadmap passes milestone (an id from ost milestone list): it goes in that milestone, and relates to nothing by default; file one only when the work can start now (what it extends exists, the decisions it needs are made, the work before it is done). Pass assignee to give it to someone ("me" for yourself) and status to start it elsewhere. Pass parent only for a planned part of a ticket\'s scope, a sub-ticket. The parent is set in the tracker\'s own parent field where it has one and is otherwise a "relates" link; never write it into the description. Use it when the work of a ticket needs several pull requests: split it into sub-tickets, one pull request each, all assigned to you: the part you start now active, the later ones ready (never backlog), and say their order on the parent. Pass blocked-by (repeatable) with each ticket that must be done first: it is linked as blocking this one, never written as text. Outside a chat session, a ticket to be worked (ready or active) with an open blocker starts blocked and moves to ready when its last blocker closes. In a chat session, the files the requester shared in their message are attached to the ticket automatically and listed in its description; mention the pictures where they belong in the description you write (for example "see the attached screenshot"). The ticket files the request as work for you: the office creates the work item for it, the requester is told about it, and when you are busy they are asked where it goes. When the requester asks for it to go to someone else, pass assignee: the ticket is then theirs, the assignment wakes them, and nothing is filed as your work; tell the requester who has it. A chat session may file several requests of one message, one ticket each; filing the same request twice is refused before anything is created. When an open ticket has a similar title, the ticket is still created and the result warns, listing it: never file a ticket for work an existing ticket already covers; change that ticket instead (ost ticket assign, move or edit). Create a ticket only for a request that is work; answer a question directly. Only a trusted human starts new work: it is refused in a round another agent started (a teammate\'s question, an unblock, a mention by an agent); put the proposal to a trusted human on the ticket instead and hand back. Rounds a human started, and follow-ups filed while working an assigned ticket, are not limited.',
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
      .describe("Key of the ticket this one is a planned part of: a sub-ticket. None by default."),
    related: key
      .optional()
      .describe(
        "Key of the ticket this one relates to. Defaults to the ticket of the work item you are in, for a follow-up.",
      ),
    milestone: milestoneId
      .optional()
      .describe("Id of the roadmap milestone it belongs to, from ost milestone list."),
    blockedBy: z
      .array(key)
      .max(20)
      .optional()
      .describe(
        "Keys of the tickets that must be done before this one; repeat the flag for each. Linked as blocking it.",
      ),
    assignee: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Member username, name or id; "me" for yourself. Unassigned when omitted, except in a chat session, where it is yours unless you name someone else.',
      ),
    say: sayInput,
  }),
  args: [],
  examples: [
    'ost ticket create --title "Add a search index" --body "Index the product names."',
    'ost ticket create --related ACME-48 --title "Rate-limit the search endpoint" --body "Found while reviewing ACME-48."',
    'ost ticket create --parent ACME-12 --title "Add the search index" --assignee me --status active --body "The index half of ACME-12."',
    'ost ticket create --parent ACME-12 --blocked-by ACME-13 --title "Search the index" --assignee me --status ready',
    'ost ticket create --title "Export orders as CSV" --body "Asked in chat." --say "Will do, starting on the export next."',
    'ost ticket create --milestone 8 --title "Collect resource metrics" --body "From the monitoring plan."',
  ],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    requireHumanStarted(env, "file a ticket");
    const current = await currentItem(env, ctx);

    // A chat session files the ticket as work; the work item that does it moves the ticket when it starts.
    const chat = current?.kind === "chat" ? current : undefined;

    // Every refusal comes before the first write: a ticket the office would then refuse must not exist.
    const say = chat ? chatLine(env, input.say) : undefined;
    if (chat) {
      await requireOffice(env).checkFiling(chat.id, input.title);
    }

    await milestoneFor(tracker, input.milestone);
    const parent = await parentIssue(tracker, input);
    const related = relatedKey(input, current, !!chat);
    const to = await assigneeFor(env, tracker, input, !!chat);
    const files = chatFiles(env, !!chat);
    const blockers = await blockerIssues(tracker, input.blockedBy);
    const blocked = startsBlocked(blockers, !!chat);
    const similar = await similarOpenTickets(tracker, input.title, [
      parent?.key,
      related,
      current?.ticketKey,
    ]);

    const issue = await tracker.createIssue(
      newIssue(tracker, input, { parent, assignee: to.member, files, chat: !!chat, blocked }),
    );

    const parentLine = await linkParent(tracker, issue.key, parent);
    await linkRelated(tracker, issue.key, related);
    const blockedLines = await linkBlockers(tracker, issue, blockers);
    const uploaded = await uploadAttachments(env, issue.key, files);
    await noteFailedUploads(tracker, issue.key, uploaded);
    const url = tracker.links.issue(issue.key);
    const warning = similarWarning(tracker, issue.key, similar);
    const office = await fileInOffice(env, chat, { key: issue.key, request: input.title, say }, to);
    await recordMade(env, current, issue.key);

    return result(
      [
        `Created ${issue.key}.`,
        ...summary(issue, url),
        ...warning.lines,
        ...uploadedLines(uploaded),
        ...blockedLines,
        ...closingLines(issue.key, parentLine, office.line, !chat && !!current),
      ],
      { issue, ...office.data, ...warning.data },
      [url, ...warning.links],
    );
  },
});

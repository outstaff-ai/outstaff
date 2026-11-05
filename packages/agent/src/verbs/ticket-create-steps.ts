import { PortError, type Issue, type Member, type Tracker } from "@outstaff/core";
import { attachmentsSection, canAttach } from "./attachments.js";
import { filedLine, requireOffice } from "./support.js";
import { resolveAssignee } from "./ticket-support.js";
import type { Filed, OfficeWorkItem } from "./office.types.js";
import type { Assignee } from "./ticket-create.types.js";
import type { AgentEnv, Uploaded, VerbContext } from "./types.js";

type Attachments = NonNullable<AgentEnv["attachments"]>;

/** The parts of an `ost ticket create` call that decide where the ticket goes and who gets it. */
interface TicketCreateInput {
  title: string;
  body: string;
  status?: "backlog" | "ready" | "active" | undefined;
  parent?: string | undefined;
  related?: string | undefined;
  milestone?: string | undefined;
  assignee?: string | undefined;
  blockedBy?: string[] | undefined;
}

/** The work item this call runs in, if any. */
export async function currentItem(
  env: AgentEnv,
  ctx: VerbContext,
): Promise<OfficeWorkItem | undefined> {
  if (!ctx.workItemId) {
    return undefined;
  }

  const items = await requireOffice(env).work({ workItemId: ctx.workItemId });
  return items.find((i) => i.id === ctx.workItemId);
}

/** The parent ticket: only the one passed. A follow-up is its own ticket, related to the one it came from. */
export async function parentIssue(
  tracker: Tracker,
  input: TicketCreateInput,
): Promise<Issue | undefined> {
  return input.parent ? tracker.getIssue(input.parent) : undefined;
}

/**
 * The ticket this one relates to: the one passed, else, for a follow-up filed in a work item that has a ticket, that
 * ticket. A sub-ticket (`parent`), a chat ticket and a ticket of a milestone relate to none by default.
 */
export function relatedKey(
  input: TicketCreateInput,
  current: OfficeWorkItem | undefined,
  chat: boolean,
): string | undefined {
  return (
    input.related ??
    (chat || input.parent || input.milestone ? undefined : (current?.ticketKey ?? undefined))
  );
}

/**
 * A chat ticket is the chat session's own work, unless it names someone else: then it is theirs. Any other ticket
 * belongs to nobody until it is given. `role:<role>` names the person the office gives the role to.
 */
export async function assigneeFor(
  env: AgentEnv,
  tracker: Tracker,
  input: TicketCreateInput,
  chat: boolean,
): Promise<Assignee> {
  if (chat) {
    return chatAssignee(env, tracker, input.assignee);
  }

  return input.assignee
    ? { ...(await resolveAssignee(env, tracker, input.assignee)), forOther: false }
    : { member: undefined, forOther: false };
}

/** The caller, unless the chat session names someone else. */
async function chatAssignee(
  env: AgentEnv,
  tracker: Tracker,
  named: string | undefined,
): Promise<Assignee> {
  const self = await selfOnTracker(env, tracker);
  if (!named || named.toLowerCase() === "me") {
    return { member: self, forOther: false };
  }

  const to = await resolveAssignee(env, tracker, named);
  return { ...to, forOther: to.member.id !== self?.id };
}

/** The caller as a tracker member, by the tracker identity team.yaml gives them. */
async function selfOnTracker(env: AgentEnv, tracker: Tracker): Promise<Member | undefined> {
  const handle = env.team.people.find((p) => p.handle === env.person)?.identities?.tracker;
  if (!handle) {
    return undefined;
  }

  return (await tracker.members()).find((m) => m.id === handle || m.username === handle);
}

/** The files of the chat message, which go with a chat ticket. */
export const chatFiles = (env: AgentEnv, chat: boolean): Attachments =>
  chat ? (env.attachments ?? []) : [];

/** A ticket to be worked (ready or active) that something still blocks starts blocked. */
const startStatus = (status: NonNullable<TicketCreateInput["status"]>, blocked: boolean) =>
  blocked && status !== "backlog" ? "blocked" : status;

/**
 * What to create: the body as written, ending with where the attached files are. The parent goes in the tracker's
 * parent field, never in the body. A ticket to be worked (ready or active) with an open blocker starts blocked.
 */
export function newIssue(
  tracker: Tracker,
  input: TicketCreateInput,
  to: {
    parent: Issue | undefined;
    assignee: Member | undefined;
    files: Attachments;
    chat: boolean;
    blocked: boolean;
  },
): Parameters<Tracker["createIssue"]>[0] {
  const { parent, assignee, files } = to;
  const described = files.length ? attachmentsSection(files, canAttach(tracker)) : "";
  return {
    title: input.title,
    body: [input.body, described].filter(Boolean).join("\n\n").trimEnd(),
    status: startStatus(input.status ?? (to.chat ? "ready" : "backlog"), to.blocked),
    ...(assignee ? { assignee: assignee.id } : {}),
    ...(parent && tracker.setParent ? { parent: parent.key } : {}),
    ...(input.milestone ? { initiative: input.milestone } : {}),
  };
}

/** Links two tickets; a tracker that refuses the link does not fail the call. */
async function linkRelates(tracker: Tracker, from: string, to: string): Promise<void> {
  await tracker.link(from, to, "relates").catch((error: unknown) => {
    if (!(error instanceof PortError)) {
      throw error;
    }
  });
}

/**
 * The real parent went in with the ticket where the tracker has one; otherwise a "relates" link. Returns the line
 * that says which.
 */
export async function linkParent(
  tracker: Tracker,
  key: string,
  parent: Issue | undefined,
): Promise<string | undefined> {
  if (!parent) {
    return undefined;
  }

  if (tracker.setParent) {
    return `Parent: ${parent.key}.`;
  }

  await linkRelates(tracker, key, parent.key);
  return `Related to ${parent.key} (this tracker has no parent field).`;
}

export async function linkRelated(
  tracker: Tracker,
  key: string,
  related: string | undefined,
): Promise<void> {
  if (related) {
    await linkRelates(tracker, key, related);
  }
}

/** The body says the files are attached; a comment says which are not. */
export async function noteFailedUploads(
  tracker: Tracker,
  key: string,
  uploaded: Uploaded,
): Promise<void> {
  if (uploaded.failed.length === 0) {
    return;
  }

  await tracker
    .comment(
      key,
      `These files could not be attached and stayed in chat: ${uploaded.failed.map((f) => f.name).join(", ")}.`,
    )
    .catch(() => {});
}

/** What a chat session is told after filing a ticket that is not its work now: someone else's, or one that waits. */
function filedForLine(assignee: string, forOther: boolean, waitsOn: string[]): string {
  const whose = forOther ? `Filed for ${assignee}: it is their work` : "Filed as your ticket";
  const wakes = waitsOn.length
    ? `It starts blocked on ${waitsOn.join(", ")}: ${forOther ? `${assignee} is` : "you are"} woken on it when the last one closes, not now.`
    : "The assignment wakes them.";

  return `${whose}. ${wakes} Your chat work is not tied to it; do not work on it. Tell the requester who has it${waitsOn.length ? " and what it waits on" : ""}, then finish with a short note.`;
}

/**
 * Tells the office about a chat ticket. The caller's own ticket, ready to work, is filed as its work, with the agent's
 * line for the reply. One for someone else, or one that starts blocked on open tickets (`waitsOn`), is only recorded
 * against the request: the assignment wakes its assignee, or, for a blocked one, the close of its last blocker
 * (`unblocked_to_ready`). Returns the line that says which, and the filing for the verb's data.
 */
export async function fileInOffice(
  env: AgentEnv,
  chat: OfficeWorkItem | undefined,
  {
    key,
    request,
    say,
    waitsOn,
  }: { key: string; request: string; say?: string | undefined; waitsOn: string[] },
  to: Assignee,
): Promise<{ line?: string; data: { filed?: Filed; filedFor?: string } }> {
  if (!chat) {
    return { data: {} };
  }

  const office = requireOffice(env);
  const forOther = to.forOther && !!to.member;
  if (!forOther && waitsOn.length === 0) {
    const filed = await office.linkTicket(chat.id, key, request, say);
    return { line: filedLine(filed), data: { filed } };
  }

  const assignee = to.member ? (to.member.username ?? to.member.name) : env.person;
  await office.fileFor(chat.id, { ticket: key, request, assignee });
  return { line: filedForLine(assignee, forOther, waitsOn), data: { filedFor: assignee } };
}

/**
 * Tells the office that a ticket created in a work item other than a chat session (which files it as work instead)
 * is the item's, so the item's hand-back gives it to the requester once it is in review. The ticket exists already:
 * a refusal costs only that.
 */
export async function recordMade(
  env: AgentEnv,
  current: OfficeWorkItem | undefined,
  key: string,
): Promise<void> {
  if (!env.office || !current || current.kind === "chat") {
    return;
  }

  await env.office.workMade({ workItemId: current.id, ticket: key }).catch((error: unknown) => {
    env.log?.warn(`could not tell the office about ${key}`, { error: String(error) });
  });
}

/** The lines after the ticket's summary: its parent, how it was filed, and a reminder to name a follow-up. */
export function closingLines(
  key: string,
  parentLine: string | undefined,
  filing: string | undefined,
  followUp: boolean,
): string[] {
  return [
    ...(parentLine ? [parentLine] : []),
    ...(filing ? [filing] : []),
    ...(followUp ? [`Name ${key} in your hand-back.`] : []),
  ];
}

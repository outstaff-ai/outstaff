import { PortError, type Issue, type Member, type Tracker } from "@outstaff/core";
import { attachmentsSection, canAttach } from "./attachments.js";
import { filedLine, requireOffice } from "./support.js";
import { memberFor } from "./ticket-support.js";
import type { Filed, OfficeWorkItem } from "./office.types.js";
import type { AgentEnv, Uploaded, VerbContext } from "./types.js";

type Attachments = NonNullable<AgentEnv["attachments"]>;

/** The parts of an `ost ticket create` call that decide where the ticket goes and who gets it. */
interface TicketCreateInput {
  title: string;
  body: string;
  status?: "backlog" | "ready" | "active" | undefined;
  parent?: string | undefined;
  related?: string | undefined;
  assignee?: string | undefined;
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

/**
 * The parent ticket: the one passed, else the ticket of the current work item. A chat ticket and an independent
 * follow-up (`related`) get no default parent.
 */
export async function parentIssue(
  tracker: Tracker,
  input: TicketCreateInput,
  current: OfficeWorkItem | undefined,
  chat: boolean,
): Promise<Issue | undefined> {
  const defaultKey = chat || input.related ? undefined : current?.ticketKey;
  const key = input.parent ?? defaultKey;
  return key ? tracker.getIssue(key) : undefined;
}

/** A chat ticket is the chat session's own work; any other ticket belongs to nobody until it is given. */
export async function assigneeFor(
  env: AgentEnv,
  tracker: Tracker,
  input: TicketCreateInput,
  chat: boolean,
): Promise<Member | undefined> {
  if (chat) {
    return selfOnTracker(env, tracker);
  }

  return input.assignee ? memberFor(env, tracker, input.assignee) : undefined;
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

/** What to create: the body opens with the parent's link and ends with where the attached files are. */
export function newIssue(
  tracker: Tracker,
  input: TicketCreateInput,
  to: {
    parent: Issue | undefined;
    assignee: Member | undefined;
    files: Attachments;
    chat: boolean;
  },
): Parameters<Tracker["createIssue"]>[0] {
  const { parent, assignee, files } = to;
  const partOf = parent ? `Part of ${parent.key}: ${tracker.links.issue(parent.key)}` : undefined;
  const described = files.length ? attachmentsSection(files, canAttach(tracker)) : "";
  return {
    title: input.title,
    body: [partOf, input.body, described].filter(Boolean).join("\n\n").trimEnd(),
    status: input.status ?? (to.chat ? "ready" : "backlog"),
    ...(assignee ? { assignee: assignee.id } : {}),
    ...(parent && tracker.setParent ? { parent: parent.key } : {}),
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

/** The lines after the ticket's summary: its parent, how it was filed, and a reminder to name a follow-up. */
export function closingLines(
  key: string,
  parentLine: string | undefined,
  filed: Filed | undefined,
  followUp: boolean,
): string[] {
  return [
    ...(parentLine ? [parentLine] : []),
    ...(filed ? [filedLine(filed)] : []),
    ...(followUp ? [`Name ${key} in your hand-back.`] : []),
  ];
}

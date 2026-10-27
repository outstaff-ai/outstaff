import type { Issue } from "@outstaff/core";
import type {
  GraphChat,
  GraphDoc,
  GraphNote,
  GraphPr,
  GraphTicket,
} from "#/pipeline/context/index.js";
import { readChatLog } from "#/chat/log.js";
import type { DocRecord, PrRecord, TicketRecord } from "#/workstate/index.js";
import type { ContextReaders } from "./types.js";

const record = async <T>(r: ContextReaders, type: string, ref: string) =>
  (await r.store.getSubject(type, ref))?.data as T | undefined;

/** Best effort: the bundle must go out when a port cannot be read, with what the office has. */
async function attempt<T>(read: (() => Promise<T>) | undefined): Promise<T | undefined> {
  try {
    return await read?.();
  } catch {
    return undefined;
  }
}

/** A ticket's fields as the tracker has them now, or else as the work state last saw them. */
function ticketFields(key: string, rec: TicketRecord | undefined, issue: Issue | undefined) {
  if (issue) {
    return {
      key,
      title: issue.title,
      url: issue.url,
      status: issue.status.canonical,
      assignee: issue.assignee?.name,
      description: issue.body,
    };
  }

  return { key, title: rec!.title, url: rec!.url, status: rec!.status };
}

/** A ticket as the work state knows it, with its description, assignee and comments when the tracker can be read. */
export async function readTicket(r: ContextReaders, key: string): Promise<GraphTicket | undefined> {
  const rec = await record<TicketRecord>(r, "ticket", key);
  const tracker = r.tracker;
  const issue = await attempt(tracker && (() => tracker.getIssue(key)));
  if (!rec && !issue) {
    return undefined;
  }

  const comments = (await attempt(tracker && (() => tracker.listComments(key)))) ?? [];
  return {
    ...ticketFields(key, rec, issue),
    comments: comments
      .map((c): GraphNote => ({ author: c.author.name, at: c.at, url: c.url, body: c.body }))
      .toSorted((a, b) => a.at.localeCompare(b.at)),
  };
}

/**
 * The unresolved review threads of an open pull request, each by its first comment, read now: the work state's count
 * is only as fresh as the pull request's last event. Undefined when the code host cannot be read.
 */
async function threadsOf(
  r: ContextReaders,
  rec: PrRecord,
): Promise<GraphPr["threads"] | undefined> {
  const vcs = r.vcs;
  if (!vcs || rec.state !== "open") {
    return undefined;
  }

  const threads = await attempt(() => vcs.reviewThreads(rec.ref.repo, rec.ref.number));
  return threads
    ?.filter((t) => !t.resolved && t.comments.length > 0)
    .map((t) => ({
      path: t.path,
      line: t.line,
      url: vcs.links.thread(rec.ref.repo, rec.ref.number, t.id),
      author: t.comments[0]!.author,
      body: t.comments[0]!.body,
    }));
}

/** A pull request as the work state knows it, with its unresolved review threads when the code host can be read. */
export async function readPr(r: ContextReaders, key: string): Promise<GraphPr | undefined> {
  const rec = await record<PrRecord>(r, "pr", key);
  if (!rec) {
    return undefined;
  }

  const threads = await threadsOf(r, rec);
  return {
    ref: key,
    number: rec.ref.number,
    title: rec.title,
    url: rec.url,
    state: rec.state,
    draft: rec.draft,
    ci: rec.ci,
    checks: rec.checks,
    mergeable: rec.mergeable,
    review: rec.review,
    unresolvedThreads: threads?.length ?? rec.unresolvedThreads,
    threads: threads ?? [],
    ticket: rec.ticket,
    stackedOn: rec.stackedOn,
  };
}

export async function readDoc(r: ContextReaders, id: string): Promise<GraphDoc | undefined> {
  const rec = await record<DocRecord>(r, "doc", id);
  return rec && { id, title: rec.title, url: rec.url, ticket: rec.ticket };
}

/** A chat thread's messages as the office received them. */
export async function readChat(r: ContextReaders, key: string): Promise<GraphChat | undefined> {
  const at = key.indexOf(":");
  const log = await readChatLog(r.store, key);
  if (at < 0 || log.length === 0) {
    return undefined;
  }

  return {
    key,
    channel: key.slice(0, at),
    thread: key.slice(at + 1),
    messages: log.map((m) => ({ author: m.author.name ?? m.author.id, at: m.at, text: m.text })),
  };
}

import type { Filed, WorkSummary } from "@outstaff/protocol";
import { summarizeItem } from "#/item-summary.js";
import { ProtocolError } from "#/protocol/errors.js";
import { CHAT_KIND, orderQueue } from "#/scheduler/policy.js";
import type { WorkItem } from "#/store/types.js";
import type { ChatDeskOptions, DeskFiling, DeskSession, FileSpec } from "./desk.types.js";
import { CHAT_ORIGIN_SUBJECT, CHAT_THREAD_SUBJECT, readOrigin, threadKey } from "./origin.js";
import { chatRefsOf } from "./refs.js";
import type { ChatOriginRecord } from "./types.js";

/** The filings that join one round per session: tickets the agent filed for itself. */
const GROUPED_SOURCE = "work_link";

/** Filing from a chat session: the session a verb was called from, and the work item it files. */
export function createFiling(opts: ChatDeskOptions): DeskFiling {
  const { store, scheduler } = opts;

  const open = async (person: string, except: string) => {
    const active = await store.listItems({ person, status: "active" });
    const queued = orderQueue(await store.listItems({ person, status: "queued" }));
    // Chat sessions answer beside the work; they are no place in the queue.
    return [...active, ...queued].filter((i) => i.id !== except && i.kind !== CHAT_KIND);
  };

  const summaries = async (items: WorkItem[]): Promise<WorkSummary[]> =>
    Promise.all(items.map((i) => summarizeItem(store, i)));

  /** Two filings are the same request when their wording is, ignoring case and spacing. */
  const requestKey = (request: string) => request.trim().replace(/\s+/g, " ").toLowerCase();

  /** The chat session a filing verb was called from. */
  async function sessionOf(
    person: string,
    sessionId: string,
    request: string,
  ): Promise<DeskSession> {
    const session = await store.getItem(sessionId);
    if (!session || session.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${sessionId} for ${person}.`);
    }

    const origin = await readOrigin(store, sessionId);
    if (session.kind !== CHAT_KIND || !origin) {
      throw new ProtocolError("invalid", "Only a chat session files work this way.");
    }

    // A message may hold several requests and each is filed once: only filing the same request again is refused.
    if (origin.requests?.includes(requestKey(request))) {
      throw new ProtocolError(
        "invalid",
        `This chat message already filed "${request}"; use that instead of filing it again. Another request in the same message is filed as its own ticket.`,
      );
    }

    return { session, origin };
  }

  /** The work item the session's earlier tickets were filed as, while it still waits to start; a ticket joins it. */
  async function groupOf(origin: ChatOriginRecord, spec: FileSpec): Promise<WorkItem | undefined> {
    if (spec.source !== GROUPED_SOURCE || !origin.group) {
      return undefined;
    }

    const group = await store.getItem(origin.group);
    return group?.status === "queued" ? group : undefined;
  }

  /**
   * A further ticket the session filed for the agent: one more ticket of the round already queued for the request, not
   * a round of its own. Nothing new is asked of the requester; the first filing asked already.
   */
  async function join(
    session: WorkItem,
    origin: ChatOriginRecord,
    group: WorkItem,
    spec: FileSpec,
  ): Promise<Filed> {
    const key = spec.subject.ref;
    const title = ((await store.getSubject("ticket", key))?.data as { title?: string } | undefined)
      ?.title;

    await store.addItemRefs(group.id, [
      { type: "ticket", ref: key, role: "attached", source: spec.source },
    ]);

    await store.appendJournal(
      group.id,
      "office",
      `The chat session also filed ${key}${title ? ` ${title}` : ""} for this request. One round covers the request: work its tickets in order, or plan them; a ticket left ready is picked up on its own once you are idle.`,
    );

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, {
      ...origin,
      requests: [...(origin.requests ?? []), requestKey(spec.request)],
    });

    return {
      item: await summarizeItem(store, (await store.getItem(group.id)) ?? group),
      waiting: false,
      work: [],
    };
  }

  /**
   * Files the work a chat session decided a message is: a work item of its own, in the session's thread. The thread
   * belongs to the new item from here on, so the requester's answer about its place and later replies reach it. The
   * agent's further tickets of the session join that item while it waits (`join`).
   */
  async function file(person: string, sessionId: string, spec: FileSpec): Promise<Filed> {
    const { session, origin } = await sessionOf(person, sessionId, spec.request);
    const group = await groupOf(origin, spec);
    return group ? join(session, origin, group, spec) : create(person, { session, origin }, spec);
  }

  /** A new work item for the filing, first in the queue when the person is idle, else last until the requester says. */
  async function create(
    person: string,
    { session, origin }: DeskSession,
    spec: FileSpec,
  ): Promise<Filed> {
    const all = await open(person, session.id);
    // Work this session filed earlier is queue order, not a reason to ask the requester where this one goes.
    const others = all.filter((i) => i.parentId !== session.id);
    const busy = others.length > 0;
    const created = await scheduler.enqueue({
      person,
      kind: spec.kind,
      title: spec.title,
      trigger: "human",
      subject: spec.subject,
      parentId: session.id,
      placement: all.length > 0 ? "last" : "next",
      source: spec.source,
      refs: await chatRefsOf(store, session.id, "trigger", spec.source),
    });

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, {
      channel: origin.channel,
      thread: origin.thread,
      requester: origin.requester,
      direct: origin.direct,
      participant: origin.participant,
      awaitingPlacement: busy,
      claimed: [],
    } satisfies ChatOriginRecord);

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, {
      ...origin,
      filed: created.id,
      ...(spec.source === GROUPED_SOURCE ? { group: created.id } : {}),
      requests: [...(origin.requests ?? []), requestKey(spec.request)],
    });

    // The thread follows the latest filing; every item filed from it reports in the same thread anyway.
    await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(origin.channel, origin.thread), {
      itemId: created.id,
    });

    await store.appendJournal(
      created.id,
      "office",
      [
        `${origin.requester.name ?? origin.requester.id} asked in chat (thread ${origin.thread}); the chat session filed it.`,
        spec.note,
        ...(busy
          ? [
              "",
              "You were busy, so this waits at the end of the queue until the requester says where it goes.",
            ]
          : []),
      ].join("\n"),
    );

    opts.notify(person);
    return {
      item: await summarizeItem(store, (await store.getItem(created.id)) ?? created),
      waiting: busy,
      work: busy ? await summaries(others.filter((i) => i.kind !== CHAT_KIND)) : [],
    };
  }

  /**
   * Notes a request the session filed for someone else: filing it again is refused, but the session still answers
   * the requester itself, so it is not marked as having filed its own work.
   */
  async function record(person: string, sessionId: string, request: string): Promise<void> {
    const { session, origin } = await sessionOf(person, sessionId, request);
    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, {
      ...origin,
      requests: [...(origin.requests ?? []), requestKey(request)],
    });
  }

  return { sessionOf, requestKey, file, record };
}

import {
  silentLogger,
  type Chat,
  type Logger,
  type TeamConfig,
  type Tracker,
} from "@outstaff/core";
import {
  formatWorkGroups,
  groupWork,
  type Filed,
  type Link,
  type PayloadOf,
  type WorkSummary,
} from "@outstaff/protocol";
import type { Cancel, Clock } from "../clock.js";
import { ProtocolError, type ChatDesk, type Messaging } from "../protocol/source.js";
import { CHAT_KIND, orderQueue } from "../scheduler/policy.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Store, WorkItem } from "../store/types.js";
import { summarizeItem } from "../work-source.js";
import { formatCurrentWork, type WorkState } from "../workstate/index.js";
import {
  CHAT_MESSAGE_SUBJECT,
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  readOrigin,
  threadKey,
  type ChatOriginRecord,
} from "./origin.js";
import { parsePlacement, placeQueued, type ParsedPlacement } from "./placement.js";

type MessageResult = PayloadOf<"chat_message_result">;
type Message = PayloadOf<"chat_message">;

export const PM_ROLE = "pm";

export interface ChatDeskOptions {
  store: Store;

  /** The scheduler without the notifying wrapper: the desk stores the origin first and then calls `notify`. */
  scheduler: Pick<Scheduler, "enqueue" | "move" | "retry">;
  team: Pick<TeamConfig, "people" | "policies">;
  workState: Pick<WorkState, "currentWork">;
  tracker?: Pick<Tracker, "links">;
  messaging?: Pick<Messaging, "ask">;

  /** Used for notes the agent cannot post itself, for example an item the scheduler blocked. */
  chat?: Chat;

  /** Pull requests and tickets of an item, as links. */
  linksOf: (item: WorkItem) => Promise<Link[]>;
  notify: (person: string) => void;
  logger?: Logger;

  /** Times the grace period before the office posts a result the agent did not. */
  clock?: Clock;

  /** How long the agent has to claim the report after its hand-back. Default 60. */
  graceSeconds?: number;
}

export const DEFAULT_CHAT_REPORT_GRACE_SECONDS = 60;

const firstLine = (text: string, max = 80) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const mention = (origin: ChatOriginRecord) => `<@${origin.requester.id}>`;

export interface ChatRequests extends ChatDesk {
  /** Tells the requester of a chat item that the scheduler blocked it. Needs the office's chat port. */
  notifyBlocked(item: WorkItem, reason: string): Promise<void>;

  /**
   * Records the hand-back of a chat item and, if the agent has not claimed the report when the grace period
   * ends, posts the result through the office's chat port.
   */
  handedBack(item: WorkItem, result: { summary: string; links: Link[] }): Promise<void>;

  /** Resumes the grace periods of hand-backs that no report claimed, after a restart. */
  resume(): Promise<void>;

  /** Cancels the pending timers. */
  stop(): void;
}

export function createChatDesk(opts: ChatDeskOptions): ChatRequests {
  const { store, scheduler } = opts;
  const log = opts.logger ?? silentLogger;

  const clock = opts.clock;
  const graceMs = (opts.graceSeconds ?? DEFAULT_CHAT_REPORT_GRACE_SECONDS) * 1000;
  const timers = new Map<string, Cancel>();
  const maxLines = opts.team.policies?.messages.max_lines ?? 3;

  const open = async (person: string, except: string) => {
    const active = await store.listItems({ person, status: "active" });
    const queued = orderQueue(await store.listItems({ person, status: "queued" }));
    // Chat sessions answer beside the work; they are no place in the queue.
    return [...active, ...queued].filter((i) => i.id !== except && i.kind !== CHAT_KIND);
  };

  const summaries = async (items: WorkItem[]): Promise<WorkSummary[]> =>
    Promise.all(items.map((i) => summarizeItem(store, i)));

  /** What the requester picks from: the lines of the grouped list, each with all its items. */
  const candidatesOf = (list: WorkSummary[]) =>
    groupWork(list).map((g) => ({
      ids: g.items.map((i) => i.id),
      title: g.ticketTitle ?? g.prTitle ?? g.title,
      ...(g.ticketKey ? { ticketKey: g.ticketKey } : {}),
    }));

  const chatSessions = opts.team.policies?.chat?.parallel_sessions ?? 2;

  /** A chat session for the message. It starts at once, beside the active item, unless all sessions are taken. */
  async function newRequest(
    person: string,
    m: Message,
    follow?: { item: WorkItem },
  ): Promise<MessageResult> {
    const thread = m.thread ?? m.messageId;
    const taken = [
      ...(await store.listItems({ person, status: "active" })),
      ...(await store.listItems({ person, status: "queued" })),
    ].filter((i) => i.kind === CHAT_KIND).length;

    const created = await scheduler.enqueue({
      person,
      kind: CHAT_KIND,
      title: `Chat: ${firstLine(m.text)}`,
      trigger: "human",
      subject: { type: "chat", ref: threadKey(m.channel, thread) },
      ...(follow ? { parentId: follow.item.id } : {}),
    });

    // A session that answered in this thread before goes on with its conversation.
    if (follow?.item.kind === CHAT_KIND && follow.item.sessionId) {
      await store.updateItem(created.id, { sessionId: follow.item.sessionId });
    }

    const origin: ChatOriginRecord = {
      channel: m.channel,
      thread,
      requester: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
      awaitingPlacement: false,
      claimed: [],
    };

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, origin);
    await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(m.channel, thread), {
      itemId: created.id,
    });

    await store.appendJournal(
      created.id,
      "office",
      `${m.author.name ?? m.author.id} asked in chat (thread ${thread}):\n${m.text}`,
    );

    opts.notify(person);
    return {
      disposition: taken < chatSessions ? "started" : "limited",
      repeated: false,
      item: await summarizeItem(store, (await store.getItem(created.id)) ?? created),
      links: [],
      work: [],
    };
  }

  /**
   * Files the work a chat session decided a message is: a work item of its own, in the session's thread. The thread
   * belongs to the new item from here on, so the requester's answer about its place and later replies reach it.
   */
  async function file(
    person: string,
    sessionId: string,
    spec: { kind: string; title: string; subject: { type: string; ref: string }; note: string },
  ): Promise<Filed> {
    const session = await store.getItem(sessionId);
    const origin =
      session && session.person === person ? await readOrigin(store, sessionId) : undefined;

    if (!session || session.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${sessionId} for ${person}.`);
    }

    if (session.kind !== CHAT_KIND || !origin) {
      throw new ProtocolError("invalid", "Only a chat session files work this way.");
    }

    if (origin.filed) {
      throw new ProtocolError(
        "invalid",
        "This chat request already filed its work; use that instead of filing a second one.",
      );
    }

    const others = await open(person, session.id);
    const busy = others.some((i) => i.kind !== CHAT_KIND);
    const created = await scheduler.enqueue({
      person,
      kind: spec.kind,
      title: spec.title,
      trigger: "human",
      subject: spec.subject,
      parentId: session.id,
      placement: busy ? "last" : "next",
    });

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, {
      channel: origin.channel,
      thread: origin.thread,
      requester: origin.requester,
      awaitingPlacement: busy,
      claimed: [],
    } satisfies ChatOriginRecord);

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, { ...origin, filed: created.id });
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

  async function place(
    person: string,
    item: WorkItem,
    origin: ChatOriginRecord,
    parsed: ParsedPlacement,
    others: WorkItem[],
    m: Message,
  ): Promise<MessageResult> {
    const base = async (): Promise<Omit<MessageResult, "disposition">> => ({
      repeated: false,
      item: await summarizeItem(store, (await store.getItem(item.id)) ?? item),
      links: [],
      work: await summaries(others),
    });

    if (parsed.type === "pm") {
      if (!opts.messaging || !opts.team.people.some((p) => p.role === PM_ROLE)) {
        return { disposition: "unclear", ...(await base()) };
      }

      try {
        const list = formatWorkGroups(groupWork(await summaries(others)), (key) =>
          opts.tracker?.links.issue(key),
        ).join("\n");

        await opts.messaging.ask(person, {
          to: PM_ROLE,
          workItemId: item.id,
          question: `${origin.requester.name ?? origin.requester.id} asked ${person} in chat: ${m.text}\n${person} is busy. Where should it go in ${person}'s queue?\n${list}`,
        });

        return { disposition: "asked_pm", ...(await base()) };
      } catch (error) {
        if (error instanceof ProtocolError) {
          return { disposition: "unclear", ...(await base()) };
        }

        throw error;
      }
    }

    let placement: string;
    if (parsed.type === "after") {
      // After the whole piece of work: behind its last queued item.
      const anchor = others
        .filter((i) => parsed.itemIds.includes(i.id) && i.status === "queued")
        .at(-1);

      if (anchor) {
        await placeQueued({ store, scheduler }, item.id, { after: anchor.id });
        const group = candidatesOf(await summaries(others)).find((c) =>
          c.ids.some((id) => parsed.itemIds.includes(id)),
        );

        placement = `after ${group?.title ?? anchor.title}`;
      } else {
        await placeQueued({ store, scheduler }, item.id, "next");
        placement = "next, right after the current item";
      }
    } else {
      await placeQueued({ store, scheduler }, item.id, parsed.type);
      placement = parsed.type;
    }

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, {
      ...origin,
      awaitingPlacement: false,
    });

    await store.appendJournal(item.id, "office", `The requester placed it ${placement}.`);
    opts.notify(person);
    return { disposition: "placed", placement, ...(await base()) };
  }

  async function retryNote(item: WorkItem, m: Message) {
    if (!opts.chat) {
      return;
    }

    try {
      await opts.chat.post(m.channel, `Retrying ${item.subject?.ref ?? item.title} on request`, {
        thread: m.thread ?? m.messageId,
      });
    } catch (error) {
      log.warn("could not post the retry note", { item: item.id, error: String(error) });
    }
  }

  async function replyInThread(
    person: string,
    item: WorkItem,
    origin: ChatOriginRecord | undefined,
    m: Message,
  ): Promise<MessageResult> {
    if (origin?.awaitingPlacement && item.status === "queued") {
      const others = await open(person, item.id);
      const candidates = await summaries(others);
      const parsed = parsePlacement(m.text, candidatesOf(candidates));

      if (parsed) {
        return place(person, item, origin, parsed, others, m);
      }

      await store.appendJournal(item.id, m.author.name ?? m.author.id, m.text);
      return {
        disposition: "unclear",
        repeated: false,
        item: await summarizeItem(store, item),
        links: [],
        work: candidates,
      };
    }

    if (item.status === "done" || item.status === "canceled") {
      return newRequest(person, m, { item });
    }

    await store.appendJournal(
      item.id,
      m.author.name ?? m.author.id,
      `In the chat thread: ${m.text}`,
    );

    let current = item;
    if (item.status === "blocked") {
      // Whatever kind of work the thread is linked to; the human's reply is the request to try again.
      const by = m.author.name ?? m.author.id;
      current = (await scheduler.retry(item.id, { by, signal: "chat reply" })) ?? item;
      opts.notify(person);
      await retryNote(item, m);
    } else if (item.status === "waiting") {
      current = await store.updateItem(item.id, { status: "queued" });
      opts.notify(person);
    }

    return {
      disposition: "joined",
      repeated: false,
      item: await summarizeItem(store, current),
      links: [],
      work: [],
    };
  }

  async function handle(person: string, m: Message): Promise<MessageResult> {
    if (m.thread) {
      const known = (await store.getSubject(CHAT_THREAD_SUBJECT, threadKey(m.channel, m.thread)))
        ?.data as { itemId: string } | undefined;

      const item = known ? await store.getItem(known.itemId) : undefined;
      if (item && item.person === person) {
        return replyInThread(person, item, await readOrigin(store, item.id), m);
      }
    }

    return newRequest(person, m);
  }

  const claim = async (item: WorkItem, origin: ChatOriginRecord, kind: string) => {
    const key = kind === "failed" || kind === "ack" ? kind : await claimKey(item, kind);
    if (origin.claimed.includes(key)) {
      return false;
    }

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, {
      ...origin,
      claimed: [...origin.claimed, key],
    });

    return true;
  };

  const claimKey = async (item: WorkItem, kind: string) =>
    `${kind}:${(await store.listRuns(item.id)).at(-1)?.id ?? "0"}`;

  /** Posts the result the agent did not, unless a report claimed it in the meantime. */
  async function recover(itemId: string) {
    timers.delete(itemId);
    const item = await store.getItem(itemId);
    const origin = item && (await readOrigin(store, itemId));
    const hb = origin && origin.handBack;
    if (
      !item ||
      !origin ||
      !hb ||
      origin.claimed.includes(hb.key) ||
      item.status !== (hb.kind === "result" ? "done" : "blocked")
    ) {
      return;
    }

    if (!opts.chat) {
      return;
    }

    const got = await claim(item, origin, hb.kind);
    if (!got) {
      return;
    }

    const lines = hb.summary.trim().split("\n");
    const body = lines.slice(0, Math.max(1, maxLines - 1)).join("\n");
    const links = [...hb.links, ...(await opts.linksOf(item))].filter(
      (l, i, all) => all.findIndex((x) => x.url === l.url) === i && !body.includes(l.url),
    );

    const text = [
      `${mention(origin)} ${hb.kind === "blocked" ? "I am blocked. " : ""}${body}`,
      "(My agent went offline before it could post this, so the office is posting it.)",
      ...links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`),
    ].join("\n");

    try {
      await opts.chat.post(origin.channel, text, { thread: origin.thread });
    } catch (error) {
      log.warn("could not post the result of a chat item for its agent", {
        item: item.id,
        error: String(error),
      });
    }
  }

  const arm = (itemId: string, at: string) => {
    if (!opts.chat || !clock) {
      log.warn("no chat port: a chat result the agent does not post will not be posted", {
        item: itemId,
      });

      return;
    }

    timers.get(itemId)?.();
    const wait = Math.max(0, Date.parse(at) + graceMs - clock.now().getTime());
    timers.set(
      itemId,
      clock.setTimeout(() => {
        void recover(itemId).catch((error: unknown) => {
          log.warn("chat result recovery failed", { item: itemId, error: String(error) });
        });
      }, wait),
    );
  };

  return {
    async handedBack(item, result) {
      const origin = await readOrigin(store, item.id);
      const kind =
        item.status === "done" ? "result" : item.status === "blocked" ? "blocked" : undefined;

      // A session that filed its request as work has nothing to report; the work reports its own result.
      if (!origin || !kind || !clock || origin.filed) {
        return;
      }

      const key = await claimKey(item, kind);
      // A retried hand-back finds it recorded, or the agent already reported it.
      if (origin.claimed.includes(key) || origin.handBack?.key === key) {
        return;
      }

      const at = clock.now().toISOString();
      await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, {
        ...origin,
        handBack: { key, kind, summary: result.summary, links: result.links, at },
      });

      arm(item.id, at);
    },

    async resume() {
      for (const status of ["done", "blocked"] as const) {
        for (const item of await store.listItems({ status })) {
          const hb =
            item.kind === CHAT_KIND ? (await readOrigin(store, item.id))?.handBack : undefined;

          if (
            hb &&
            hb.key === (await claimKey(item, hb.kind)) &&
            !(await readOrigin(store, item.id))?.claimed.includes(hb.key)
          ) {
            arm(item.id, hb.at);
          }
        }
      }
    },

    stop() {
      for (const cancel of timers.values()) {
        cancel();
      }

      timers.clear();
    },

    async message(person, m) {
      const key = `${person}:${m.channel}:${m.messageId}`;
      const seen = (await store.getSubject(CHAT_MESSAGE_SUBJECT, key))?.data as
        | MessageResult
        | undefined;

      if (seen) {
        return { ...seen, repeated: true };
      }

      const result = await handle(person, m);
      await store.upsertSubject(CHAT_MESSAGE_SUBJECT, key, result);
      return result;
    },

    async report(person, workItemId, kind) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      const origin = await readOrigin(store, item.id);
      const ended =
        kind === "result"
          ? item.status === "done"
          : kind === "blocked"
            ? item.status === "blocked"
            : true;

      if (!origin || !ended || !(await claim(item, origin, kind))) {
        return { post: false, links: [] };
      }

      return { post: true, requester: origin.requester.id, links: await opts.linksOf(item) };
    },

    async linkTicket(person, workItemId, ticket) {
      const title = (await store.getSubject("ticket", ticket))?.data as
        | { title?: string }
        | undefined;

      const filed = await file(person, workItemId, {
        kind: "assigned",
        title: `assigned: ${ticket}${title?.title ? ` ${title.title}` : ""}`,
        subject: { type: "ticket", ref: ticket },
        note: `Tracked in ${ticket}.`,
      });

      const url = opts.tracker?.links.issue(ticket);
      return { ...filed, ...(url ? { url } : {}) };
    },

    queueWork(person, workItemId, request) {
      return file(person, workItemId, {
        kind: "request",
        title: request.title,
        subject: { type: "chat", ref: workItemId },
        note: request.body,
      });
    },

    async currentWork(person) {
      return formatCurrentWork(opts.workState.currentWork(person));
    },

    async notifyBlocked(item, reason) {
      const origin = await readOrigin(store, item.id);
      if (!origin || !opts.chat || !(await claim(item, origin, "blocked"))) {
        return;
      }

      const links = await opts.linksOf(item);
      const text = [
        `${mention(origin)} I could not carry on with this: ${firstLine(reason, 200)}`,
        ...links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`),
      ].join("\n");

      try {
        await opts.chat.post(origin.channel, text, { thread: origin.thread });
      } catch (error) {
        log.warn("could not tell the requester about a blocked item", {
          item: item.id,
          error: String(error),
        });
      }
    },
  };
}

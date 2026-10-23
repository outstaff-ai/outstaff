import {
  silentLogger,
  type Chat,
  type Logger,
  type TeamConfig,
  type Tracker,
} from "@outstaff/core";
import type { Link, PayloadOf, WorkSummary } from "@outstaff/protocol";
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
  scheduler: Pick<Scheduler, "enqueue" | "move">;
  team: Pick<TeamConfig, "people">;
  workState: Pick<WorkState, "currentWork">;
  tracker?: Pick<Tracker, "links">;
  messaging?: Pick<Messaging, "ask">;

  /** Used for notes the agent cannot post itself, for example an item the scheduler blocked. */
  chat?: Chat;

  /** Pull requests and tickets of an item, as links. */
  linksOf: (item: WorkItem) => Promise<Link[]>;
  notify: (person: string) => void;
  logger?: Logger;
}

const firstLine = (text: string, max = 80) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const mention = (origin: ChatOriginRecord) => `<@${origin.requester.id}>`;

export interface ChatRequests extends ChatDesk {
  /** Tells the requester of a chat item that the scheduler blocked it. Needs the office's chat port. */
  notifyBlocked(item: WorkItem, reason: string): Promise<void>;
}

export function createChatDesk(opts: ChatDeskOptions): ChatRequests {
  const { store, scheduler } = opts;
  const log = opts.logger ?? silentLogger;

  const open = async (person: string, except: string) => {
    const active = await store.listItems({ person, status: "active" });
    const queued = orderQueue(await store.listItems({ person, status: "queued" }));
    return [...active, ...queued].filter((i) => i.id !== except);
  };

  const summaries = async (items: WorkItem[]): Promise<WorkSummary[]> =>
    Promise.all(items.map((i) => summarizeItem(store, i)));

  async function newRequest(
    person: string,
    m: Message,
    follow?: { item: WorkItem },
  ): Promise<MessageResult> {
    const thread = m.thread ?? m.messageId;
    const busy = (await open(person, "")).length > 0;
    const subject = follow?.item.subject ?? { type: "chat", ref: threadKey(m.channel, thread) };

    const created = await scheduler.enqueue({
      person,
      kind: CHAT_KIND,
      title: `Chat: ${firstLine(m.text)}`,
      trigger: "human",
      subject,
      placement: busy ? "last" : "next",
      ...(follow ? { parentId: follow.item.id } : {}),
    });

    if (follow) {
      await store.updateItem(created.id, {
        sessionId: follow.item.sessionId,
        workspace: follow.item.workspace,
      });
    }

    const origin: ChatOriginRecord = {
      channel: m.channel,
      thread,
      requester: { id: m.author.id, ...(m.author.name ? { name: m.author.name } : {}) },
      awaitingPlacement: busy,
      claimed: [],
    };

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, origin);
    await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(m.channel, thread), {
      itemId: created.id,
    });

    await store.appendJournal(
      created.id,
      "office",
      [
        `${m.author.name ?? m.author.id} asked in chat (thread ${thread}):`,
        m.text,
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
      disposition: busy ? "waiting" : "started",
      repeated: false,
      item: await summarizeItem(store, (await store.getItem(created.id)) ?? created),
      links: [],
      work: busy ? await summaries(await open(person, created.id)) : [],
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
        const list = others.map((i) => `- ${i.title} (${i.status})`).join("\n");
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
      const anchor = others.find((i) => i.id === parsed.itemId);
      if (anchor?.status === "queued") {
        await placeQueued({ store, scheduler }, item.id, { after: anchor.id });
        placement = `after ${anchor.title}`;
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

  async function replyInThread(
    person: string,
    item: WorkItem,
    origin: ChatOriginRecord | undefined,
    m: Message,
  ): Promise<MessageResult> {
    if (origin?.awaitingPlacement && item.status === "queued") {
      const others = await open(person, item.id);
      const candidates = await summaries(others);
      const parsed = parsePlacement(
        m.text,
        candidates.map((c) => ({ id: c.id, title: c.title, ticketKey: c.ticketKey })),
      );

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
    if (item.status === "waiting" || item.status === "blocked") {
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
    const run = (await store.listRuns(item.id)).at(-1);
    const key = kind === "failed" || kind === "ack" ? kind : `${kind}:${run?.id ?? "0"}`;
    if (origin.claimed.includes(key)) {
      return false;
    }

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, {
      ...origin,
      claimed: [...origin.claimed, key],
    });

    return true;
  };

  return {
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
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      if (!(await readOrigin(store, item.id))) {
        throw new ProtocolError(
          "invalid",
          "Only a chat request's work item takes a ticket this way.",
        );
      }

      if (item.subject?.type !== "chat") {
        throw new ProtocolError(
          "invalid",
          `Work item ${workItemId} already has a ${item.subject?.type ?? "subject"}; create no ticket for it.`,
        );
      }

      await store.updateItem(item.id, { subject: { type: "ticket", ref: ticket } });
      await store.appendJournal(item.id, person, `Tracked in ${ticket}.`);
      const url = opts.tracker?.links.issue(ticket);
      return url ? { url } : {};
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

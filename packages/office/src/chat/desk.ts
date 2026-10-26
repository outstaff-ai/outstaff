import { blockedNotify, policyOn, type TeamConfig, type Tracker } from "@outstaff/core";
import {
  formatWorkGroups,
  groupWork,
  type Attached,
  type ChatOrigin,
  type Feedback,
  type Filed,
  type Link,
  type PayloadOf,
  type QueuedReport,
  type WorkSummary,
} from "@outstaff/protocol";
import type { Clock } from "../clock.js";
import { ProtocolError, type ChatDesk, type Messaging } from "../protocol/source.js";
import { CHAT_KIND, orderQueue } from "../scheduler/policy.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Store, WorkItem } from "../store/types.js";
import { summarizeItem } from "../work-source.js";
import {
  formatCurrentWork,
  type PrRecord,
  type TicketRecord,
  type WorkState,
} from "../workstate/index.js";
import { addFeedback } from "../engine/feedback.js";
import {
  CHAT_MESSAGE_SUBJECT,
  ATTACH_REASSIGN_SUBJECT,
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  readOrigin,
  threadKey,
  threadsOf,
  withThread,
  type ChatOriginRecord,
} from "./origin.js";
import { createReportQueue } from "./pending.js";
import { parsePlacement, placeQueued, type ParsedPlacement } from "./placement.js";

type MessageResult = PayloadOf<"chat_message_result">;
type Message = PayloadOf<"chat_message">;

export const PM_ROLE = "pm";

const reportId = (r: { itemId: string; key: string }) => `${r.itemId}:${r.key}`;

/** Work that answers something and changes no ticket: a blocked end of it tells no requester. */
const SILENT_KINDS = new Set(["asked", "doc_feedback"]);

export interface ChatDeskOptions {
  store: Store;

  /** The scheduler without the notifying wrapper: the desk stores the origin first and then calls `notify`. */
  scheduler: Pick<Scheduler, "enqueue" | "move" | "retry">;
  team: Pick<TeamConfig, "people" | "policies"> & Partial<Pick<TeamConfig, "integrations">>;
  workState: Pick<
    WorkState,
    "currentWork" | "pullRequests" | "ticket" | "prSubject" | "lastWorker" | "catchUp"
  >;
  tracker?: Pick<Tracker, "links">;
  messaging?: Pick<Messaging, "ask">;

  /**
   * The chat user id of the human who asked for the item's work, for the blocked report of an item that did not
   * come from chat. Undefined when there is no known requester or no chat identity for them.
   */
  requesterChat?: (item: WorkItem) => Promise<string | undefined>;

  /** Pull requests and tickets of an item, as links. */
  linksOf: (item: WorkItem) => Promise<Link[]>;
  notify: (person: string) => void;

  /** Tells the server to send the person's queued reports now; the agent also gets them when it connects. */
  push?: (person: string) => void;

  clock?: Clock;
}

const firstLine = (text: string, max = 80) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The message's text with a line naming its files, for the journal. The files are data from the author. */
const withFiles = (m: Pick<Message, "text" | "files">) =>
  m.files?.length
    ? `${m.text}\n(Shared ${m.files.map((f) => `${f.name} (${f.mimetype})`).join(", ")}.)`.trimStart()
    : m.text;

export interface ChatRequests extends ChatDesk {
  /**
   * An item the scheduler blocked (the agent did not hand it back): queues the report its agent owes the requester,
   * so the agent posts it as itself (the thread of a chat item, else a direct message), live if connected and
   * otherwise on its next connection. With `routedToPm` a ticket's block is the PM's, and only a chat thread is told.
   */
  blocked(item: WorkItem, reason: string, routedToPm: boolean): Promise<void>;

  /**
   * Records the hand-back of an item whose requester is to hear how it ended: the chat result of a chat item, and
   * the blocked report when the blocked agent reports itself. The agent claims it with `chat_report`; if it did not
   * (it was offline), `queued` hands it over when the agent connects. The office posts nothing.
   */
  handedBack(item: WorkItem, result: { summary: string; links: Link[] }): Promise<void>;
}

export function createChatDesk(opts: ChatDeskOptions): ChatRequests {
  const { store, scheduler } = opts;

  const clock = opts.clock;
  const reports = createReportQueue(store);

  /**
   * Whether the blocked agent reports a blocked hand-back to the requester itself. Always in the thread a human asked
   * in (the agent replying there is not a notification); for work without a chat origin only when the team routes
   * blocked work to the agent, or the blocked agent is the PM, who has nobody to route it to.
   */
  const reportsBlocked = (item: WorkItem, origin: ChatOriginRecord | undefined) =>
    origin !== undefined ||
    blockedNotify(opts.team) === "agent" ||
    opts.team.people.some((p) => p.handle === item.person && p.role === PM_ROLE);

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

  /**
   * A chat session for the message. It starts at once, beside the active item, unless all sessions are taken.
   * `follow` is a finished item of the thread, whose conversation the session goes on with and which the thread
   * moves on from. `beside` is the running item the thread is linked to: the session gets its context and the
   * thread stays linked to it, so its result is still posted there.
   */
  async function newRequest(
    person: string,
    m: Message,
    link?: { follow: WorkItem } | { beside: WorkItem },
  ): Promise<MessageResult> {
    const follow = link && "follow" in link ? { item: link.follow } : undefined;
    const beside = link && "beside" in link ? link.beside : undefined;
    // The earlier work of the thread, so the session continues its ticket instead of filing a duplicate. A chat
    // session that only answered has no work to continue.
    const about = beside ?? (follow && follow.item.kind !== CHAT_KIND ? follow.item : undefined);
    const thread = m.thread ?? m.messageId;
    const taken = [
      ...(await store.listItems({ person, status: "active" })),
      ...(await store.listItems({ person, status: "queued" })),
    ].filter((i) => i.kind === CHAT_KIND).length;

    const created = await scheduler.enqueue({
      person,
      kind: CHAT_KIND,
      title: `Chat: ${firstLine(m.text) || m.files?.[0]?.name || "(no text)"}`,
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
      direct: m.direct,
      participant: m.participant,
      awaitingPlacement: false,
      claimed: [],
      text: m.text,
      ...(m.files?.length ? { files: m.files } : {}),
      ...(about
        ? { about: { id: about.id, title: about.title, state: beside ? "running" : "finished" } }
        : {}),
    };

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, origin);
    if (!beside) {
      await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(m.channel, thread), {
        itemId: created.id,
      });
    }

    await store.appendJournal(
      created.id,
      "office",
      `${m.author.name ?? m.author.id} ${beside ? "replied" : "asked"} in chat (thread ${thread}):\n${withFiles(m)}`,
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

  /** The chat session a filing verb was called from. */
  async function sessionOf(person: string, sessionId: string) {
    const session = await store.getItem(sessionId);
    if (!session || session.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${sessionId} for ${person}.`);
    }

    const origin = await readOrigin(store, sessionId);
    if (session.kind !== CHAT_KIND || !origin) {
      throw new ProtocolError("invalid", "Only a chat session files work this way.");
    }

    if (origin.filed) {
      throw new ProtocolError(
        "invalid",
        "This chat request already filed its work; use that instead of filing a second one.",
      );
    }

    return { session, origin };
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
    const { session, origin } = await sessionOf(person, sessionId);
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
      direct: origin.direct,
      participant: origin.participant,
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

  const LIVE: WorkItem["status"][] = ["active", "queued", "waiting", "blocked"];
  const assignedTo = (person: string, t?: TicketRecord) =>
    t?.assignee?.kind === "agent" && t.assignee.id === person;

  /** Work the agent can attach to: assigned to it, or it was the last to work on it (a hand-back reassigns to the requester). */
  const ownTicket = (person: string, t?: TicketRecord) =>
    assignedTo(person, t) || (t !== undefined && opts.workState.lastWorker(t.key) === person);

  interface Target {
    ticket?: TicketRecord;
    pr?: PrRecord;
  }

  /** The existing work a verb argument names, if it is the person's own. */
  function resolve(person: string, text: string): Target {
    const t = text.trim();
    const refuse = (why: string): never => {
      throw new ProtocolError("invalid", why);
    };

    const mine = (pr: PrRecord) =>
      pr.author.person === person ||
      ownTicket(person, pr.ticket ? opts.workState.ticket(pr.ticket) : undefined);

    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t)) {
      const ticket = opts.workState.ticket(t) ?? opts.workState.ticket(t.toUpperCase());
      if (!ticket || !ownTicket(person, ticket)) {
        return refuse(
          `No ticket ${t} is your work: it is not assigned to you and you were not the last to work on it. Attach a request only to your own work.`,
        );
      }

      return { ticket };
    }

    const number = /(?:^|[#/])(\d+)$/.exec(t)?.[1];
    if (number === undefined) {
      return refuse(
        `Say a ticket key (ACME-11) or a pull request (11, #11, owner/repo#11 or its link), not "${t}".`,
      );
    }

    const found = opts.workState.pullRequests(Number(number)).filter(mine);
    const named = found.filter(
      (p) => t.includes("/") && t.toLowerCase().includes(p.ref.repo.name.toLowerCase()),
    );

    const pool = named.length > 0 ? named : found;
    if (pool.length === 0) {
      return refuse(`No pull request #${number} is yours. Attach a request only to your own work.`);
    }

    if (pool.length > 1) {
      return refuse(
        `More than one of your repositories has a pull request #${number}; say which: ${pool.map((p) => opts.workState.prSubject(p.ref)).join(", ")}.`,
      );
    }

    const pr = pool[0]!;
    return {
      pr,
      ...(pr.ticket && opts.workState.ticket(pr.ticket)
        ? { ticket: opts.workState.ticket(pr.ticket)! }
        : {}),
    };
  }

  const TERMINAL = new Set(["done", "canceled"]);

  async function attachWork(
    person: string,
    sessionId: string,
    request: { target: string; confirmed: boolean; request?: string },
  ): Promise<Attached> {
    const { session, origin } = await sessionOf(person, sessionId);
    const target = resolve(person, request.target);

    // A ticket is the work of its open pull request, when it has one.
    let { ticket, pr } = target;
    if (!pr && ticket) {
      // A pull request opened a moment ago may not be in the work state yet.
      await opts.workState.catchUp();
      const open = opts.workState.currentWork(person).prs.find((p) => p.ticket === ticket!.key);
      pr =
        open &&
        opts.workState
          .pullRequests(open.number)
          .find((p) => opts.workState.prSubject(p.ref) === open.ref);
    }

    const what = pr ? `PR #${pr.ref.number}` : (ticket?.key ?? request.target);
    if (pr ? pr.state !== "open" : TERMINAL.has(ticket?.status ?? "")) {
      throw new ProtocolError(
        "invalid",
        `${what} is ${pr ? pr.state : ticket?.status}, and finished work is never reopened. File a follow-up instead: ost ticket create, linking ${what} and saying it depends on it.`,
      );
    }

    if (ticket && TERMINAL.has(ticket.status ?? "")) {
      throw new ProtocolError(
        "invalid",
        `${ticket.key} is ${ticket.status}, and finished work is never reopened. File a follow-up instead: ost ticket create, linking ${ticket.key} and saying it depends on it.`,
      );
    }

    const inReview = pr ? !pr.draft : ticket?.status === "review";
    if (inReview && !request.confirmed) {
      throw new ProtocolError(
        "invalid",
        `${what} is in review. Do not add to it on your own: ask the requester in the thread, linking both options ("Add this to ${what}, which is in review, or do it as a follow-up?"). When they say this one, run this again with --confirmed. When they say follow-up, file it with ost ticket create, linking ${what} and saying it depends on it. Nothing is queued meanwhile.`,
      );
    }

    const subject = pr
      ? { type: "pr", ref: opts.workState.prSubject(pr.ref) }
      : { type: "ticket", ref: ticket!.key };

    const key = ticket?.key ?? pr?.ticket;
    const who = origin.requester.name ?? origin.requester.id;
    // The session's message is the request, unless it is only the answer to a question about where the request goes.
    const message = request.request?.trim() || origin.text || "";
    const feedback: Feedback = {
      actor: who,
      kind: "chat",
      body: message,
      ...(clock ? { at: clock.now().toISOString() } : {}),
    };

    const note = `${who} asked in chat (thread ${origin.thread}); added to ${what}${key && !pr ? "" : key ? ` for ${key}` : ""}:\n${message}`;
    const live = (await store.listItems({ person }))
      .filter(
        (i) =>
          LIVE.includes(i.status) &&
          i.kind !== CHAT_KIND &&
          i.id !== session.id &&
          ((i.subject?.type === "pr" && i.subject.ref === subject.ref) ||
            (key !== undefined && i.subject?.type === "ticket" && i.subject.ref === key)),
      )
      .toSorted((a, b) => LIVE.indexOf(a.status) - LIVE.indexOf(b.status));

    if (key && !assignedTo(person, opts.workState.ticket(key))) {
      await store.upsertSubject(ATTACH_REASSIGN_SUBJECT, `${person}:${key}`, { pending: true });
    }

    const attachedOrigin: ChatOriginRecord = {
      channel: origin.channel,
      thread: origin.thread,
      requester: origin.requester,
      direct: origin.direct,
      participant: origin.participant,
      awaitingPlacement: false,
      claimed: [],
    };

    // The attached work keeps its place: nothing is asked about it, and an active round is not interrupted.
    let item = live[0];
    if (item) {
      await store.appendJournal(item.id, who, `In chat: ${message}`);
      if (item.status === "blocked") {
        item = (await scheduler.retry(item.id, { by: who, signal: "chat reply" })) ?? item;
      } else if (item.status === "waiting") {
        item = await store.updateItem(item.id, { status: "queued" });
      }
    } else {
      const title =
        pr !== undefined
          ? `review feedback: PR #${pr.ref.number}${pr.title ? ` ${pr.title}` : ""}${key && !pr.title.toLowerCase().includes(key.toLowerCase()) ? ` (${key})` : ""}`
          : `assigned: ${ticket!.key} ${ticket!.title}`.trim();

      item = await scheduler.enqueue({
        person,
        kind: pr ? "review_feedback" : "assigned",
        title,
        trigger: "human",
        subject,
        parentId: session.id,
        // Before the item can be offered, so the offer carries its feedback and origin.
        init: async (created) => {
          await addFeedback(store, created.id, feedback);
          await store.upsertSubject(CHAT_ORIGIN_SUBJECT, created.id, attachedOrigin);
        },
      });

      await store.appendJournal(item.id, "office", note);
    }

    if (live[0]) {
      // Queued, the item offers the message with its other feedback; running, a follow-up round starts after its
      // hand-back and picks it up. The item keeps the origin it has and gains this thread, so every linked thread
      // gets its result.
      await addFeedback(store, item.id, feedback);
      const existing = await readOrigin(store, item.id);
      await store.upsertSubject(
        CHAT_ORIGIN_SUBJECT,
        item.id,
        existing ? withThread(existing, attachedOrigin) : attachedOrigin,
      );
    }

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, { ...origin, filed: item.id });
    await store.upsertSubject(CHAT_THREAD_SUBJECT, threadKey(origin.channel, origin.thread), {
      itemId: item.id,
    });

    opts.notify(person);
    const ticketUrl = key ? (ticket?.url ?? opts.tracker?.links.issue(key)) : undefined;
    return {
      item: await summarizeItem(store, (await store.getItem(item.id)) ?? item),
      waiting: false,
      work: [],
      attached: {
        ...(key
          ? {
              ticket: {
                type: "ticket",
                ref: key,
                ...(ticket?.title ? { title: ticket.title } : {}),
                ...(ticketUrl ? { url: ticketUrl } : {}),
              },
            }
          : {}),
        ...(pr
          ? {
              pr: {
                type: "pr",
                ref: `#${pr.ref.number}`,
                title: pr.title,
                ...(pr.url ? { url: pr.url } : {}),
              },
            }
          : {}),
      },
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
      return newRequest(person, m, { follow: item });
    }

    await store.appendJournal(
      item.id,
      m.author.name ?? m.author.id,
      `In the chat thread: ${withFiles(m)}`,
    );

    // The running work does not see the reply, so a chat session beside it answers at once.
    if (item.status === "active") {
      return newRequest(person, m, { beside: item });
    }

    let current = item;
    if (item.status === "blocked" && policyOn(opts.team.policies, "retry.on_signal")) {
      // Whatever kind of work the thread is linked to; the human's reply is the request to try again.
      const by = m.author.name ?? m.author.id;
      current = (await scheduler.retry(item.id, { by, signal: "chat reply" })) ?? item;
      opts.notify(person);
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

  /** Where the agent posts a report: the chat threads of the item, else the requester's direct message. */
  async function placeOf(
    item: WorkItem,
    origin: ChatOriginRecord | undefined,
    kind: "result" | "blocked" | "ack" | "failed",
  ): Promise<{ requester: string; threads?: ChatOrigin[]; direct?: string } | undefined> {
    if (origin) {
      return { requester: origin.requester.id, threads: threadsOf(origin) };
    }

    const direct = kind === "blocked" ? await opts.requesterChat?.(item) : undefined;
    return direct ? { requester: direct, direct } : undefined;
  }

  return {
    async handedBack(item, result) {
      const origin = await readOrigin(store, item.id);
      const kind =
        item.status === "done" ? "result" : item.status === "blocked" ? "blocked" : undefined;

      // A session that filed its request as work has nothing to report; the work reports its own result.
      if (!kind || !clock || origin?.filed) {
        return;
      }

      // The result is for the chat thread that asked; a blocked item is reported when the agent is the one to do it.
      // Answering someone else's question or a document comment is not the work the requester waits for.
      if (
        kind === "result"
          ? !origin
          : !reportsBlocked(item, origin) || (!origin && SILENT_KINDS.has(item.kind))
      ) {
        return;
      }

      const key = await claimKey(item, kind);
      // A retried hand-back finds it queued, or the agent already reported it.
      if (origin?.claimed.includes(key)) {
        return;
      }

      await reports.add(item.person, {
        itemId: item.id,
        key,
        kind,
        summary: result.summary,
        links: result.links,
        at: clock.now().toISOString(),
      });
    },

    async queued(person) {
      const out: QueuedReport[] = [];
      for (const entry of await reports.list(person)) {
        const item = await store.getItem(entry.itemId);
        const origin = item && (await readOrigin(store, item.id));
        const ended = item?.status === (entry.kind === "result" ? "done" : "blocked");
        // The ending is gone (the item was retried) or the agent posted it itself already.
        if (!item || !ended || origin?.claimed.includes(entry.key)) {
          await reports.settle(person, entry.itemId, entry.key);
          continue;
        }

        const where = await placeOf(item, origin, entry.kind);
        if (!where) {
          await reports.settle(person, entry.itemId, entry.key);
          continue;
        }

        out.push({
          id: reportId(entry),
          workItemId: item.id,
          kind: entry.kind,
          text: entry.summary,
          ...where,
          links: [...entry.links, ...(await opts.linksOf(item))],
        });
      }

      return out;
    },

    async posted(person, workItemId, id) {
      const entry = (await reports.list(person)).find(
        (r) => r.itemId === workItemId && reportId(r) === id,
      );

      // Confirmed twice, or the report was settled another way: nothing left to do.
      if (!entry) {
        return;
      }

      const origin = await readOrigin(store, workItemId);
      if (origin && !origin.claimed.includes(entry.key)) {
        await store.upsertSubject(CHAT_ORIGIN_SUBJECT, workItemId, {
          ...origin,
          claimed: [...origin.claimed, entry.key],
        });
      }

      await reports.settle(person, workItemId, entry.key);
    },

    async blocked(item, reason, routedToPm) {
      const origin = await readOrigin(store, item.id);
      // The PM deals with a ticket's block; the thread a human asked in still gets its agent's reply.
      if (!clock || origin?.filed || (routedToPm && !origin)) {
        return;
      }

      if (!origin && SILENT_KINDS.has(item.kind)) {
        return;
      }

      const key = `${await claimKey(item, "blocked")}:${clock.now().toISOString()}`;
      await reports.add(item.person, {
        itemId: item.id,
        key,
        kind: "blocked",
        summary: firstLine(reason, 200),
        links: [],
        at: clock.now().toISOString(),
      });

      opts.push?.(item.person);
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
            ? item.status === "blocked" && reportsBlocked(item, origin)
            : true;

      if (!ended) {
        return { post: false, links: [] };
      }

      const key = kind === "result" || kind === "blocked" ? await claimKey(item, kind) : undefined;
      if (origin) {
        if (!(await claim(item, origin, kind))) {
          return { post: false, links: [] };
        }
      } else if (kind !== "blocked" || (await reports.done(person, item.id, key!))) {
        // Only a blocked item without a chat thread has someone to tell: the requester, in a direct message.
        return { post: false, links: [] };
      }

      const where = await placeOf(item, origin, kind);
      if (!where) {
        return { post: false, links: [] };
      }

      if (key) {
        await reports.settle(person, item.id, key);
      }

      return { post: true, ...where, links: await opts.linksOf(item) };
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

    attachWork,

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
  };
}

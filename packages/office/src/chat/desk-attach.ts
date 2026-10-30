import type { Attached, Feedback } from "@outstaff/protocol";
import { summarizeItem } from "#/item-summary.js";
import { ProtocolError } from "#/protocol/errors.js";
import { CHAT_KIND } from "#/scheduler/policy.js";
import type { WorkItem } from "#/store/types.js";
import { addFeedback } from "#/work-feedback.js";
import type { ChatDeskOptions, ChatRequests, DeskFiling } from "./desk.types.js";
import { resolveOwnWork } from "./desk-resolve.js";
import {
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  readOrigin,
  threadKey,
  withThread,
} from "./origin.js";
import { chatRefsOf } from "./refs.js";
import type { ChatOriginRecord } from "./types.js";

/** Work that is still open, the order an attached request prefers it in. */
const LIVE: WorkItem["status"][] = ["active", "queued", "waiting", "blocked"];

/**
 * `ost work attach`: makes a chat session's request part of existing work of the person, as a round on its pull
 * request or ticket, or as feedback on the item already working on it, with the thread moved to that item.
 */
export function createAttach(
  opts: ChatDeskOptions,
  filing: DeskFiling,
): ChatRequests["attachWork"] {
  const { store, scheduler } = opts;
  const clock = opts.clock;

  const TERMINAL = new Set(["done", "canceled"]);

  async function attachWork(
    person: string,
    sessionId: string,
    request: { target: string; confirmed: boolean; request?: string },
  ): Promise<Attached> {
    const { session, origin } = await filing.sessionOf(
      person,
      sessionId,
      `attach ${request.target}`,
    );

    const target = resolveOwnWork(opts.workState, person, request.target);

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

    // An open pull request is unfinished work whatever its ticket says: a merge into a stack's feature branch can
    // close the ticket early. The request attaches to it; the ticket stays done.
    const closedEarly = pr !== undefined && ticket?.status === "done";
    if (ticket && TERMINAL.has(ticket.status ?? "") && !closedEarly) {
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
    const chatRefs = await chatRefsOf(store, session.id, "attached", "work_attach");
    let item = live[0];
    if (item) {
      await store.addItemRefs(item.id, chatRefs);
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
        source: "work_attach",
        refs: chatRefs,
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

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, session.id, {
      ...origin,
      filed: item.id,
      requests: [...(origin.requests ?? []), filing.requestKey(`attach ${request.target}`)],
    });

    await store.addItemRefs(session.id, [
      ...(key
        ? [{ type: "ticket" as const, ref: key, role: "attached" as const, source: "work_attach" }]
        : []),
      ...(pr
        ? [
            {
              type: "pr" as const,
              ref: subject.ref,
              url: pr.url,
              role: "attached" as const,
              source: "work_attach",
            },
          ]
        : []),
    ]);

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

  return attachWork;
}

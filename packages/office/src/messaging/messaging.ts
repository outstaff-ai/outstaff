import { silentLogger } from "@outstaff/core";
import type { AnswerState } from "@outstaff/protocol";
import { ProtocolError } from "#/protocol/errors.js";
import type { Messaging } from "#/protocol/source.types.js";
import type { Conversation, WorkItem } from "#/store/types.js";
import { mirror } from "./mirror.js";
import { loadByPerson, readRoster } from "./roster.js";
import { routeQuestion } from "./routing.js";
import type { MessagingOptions } from "./types.js";

export const QUESTION_KIND = "question";
export const CONVERSATION_SUBJECT = "conversation";
export const DEFAULT_MAX_DEPTH = 3;

const firstLine = (text: string, max = 80) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const MIRRORED: Record<string, string> = {
  channel: "the team channel",
  ticket: "the ticket",
  journal: "the work journal only",
};

/** The statuses a hand-back leaves the asker in that let it take the answers that came in meanwhile. */
const RESUMING = new Set<string>(["waiting", "queued", "done"]);

/** What the person asked sees first: the question, who asks it and from which work, and how to answer. */
function questionBrief(
  id: string,
  from: string,
  role: string,
  asker: WorkItem,
  question: string,
): string {
  const about = asker.subject ? `\nAbout: ${asker.subject.type} ${asker.subject.ref}` : "";
  return [
    `Question ${id} from ${from} (${role}):`,
    question,
    "",
    `${from} is working on: ${asker.title} (work item ${asker.id}).${about}`,
    `Answer with: ost answer ${id} "<your answer>". ${from} continues with it.`,
  ].join("\n");
}

/** The answers that arrived while the asker was working, for its journal. */
function lateAnswers(pending: Conversation[]): string {
  const lines = pending.map(
    (c) => `- ${c.target} on question ${c.id} (${c.question}): ${c.answer ?? ""}`,
  );

  return `Answers that arrived while you were working:\n${lines.join("\n")}`;
}

export function createMessaging(
  opts: MessagingOptions,
): Required<Pick<Messaging, "ask" | "answer" | "roster" | "onHandBack">> {
  const { store, scheduler } = opts;
  const log = opts.logger ?? silentLogger;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const channel = opts.channel ?? opts.team.office?.channel;
  const mirrorOpts = {
    chat: opts.chat,
    channel,
    tracker: opts.tracker,
    logger: log,
  };

  const mirrorTo = async (asker: WorkItem, text: string) => {
    const where = await mirror(mirrorOpts, asker, text);
    return MIRRORED[where]!;
  };

  /** The asker's own work item: a question is asked from inside one, so the answer finds its way back. */
  const askingItem = async (from: string, workItemId: string | undefined): Promise<WorkItem> => {
    if (!workItemId) {
      throw new ProtocolError(
        "invalid",
        "Ask from inside a work item, so the answer can find its way back.",
      );
    }

    const asker = await store.getItem(workItemId);
    if (!asker || asker.person !== from) {
      throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${from}.`);
    }

    return asker;
  };

  const roleOf = (handle: string) =>
    opts.team.people.find((p) => p.handle === handle)?.role ?? "unknown role";

  const depthOf = async (asker: WorkItem): Promise<number> => {
    if (asker.subject?.type === CONVERSATION_SUBJECT) {
      const parent = await store.getConversation(asker.subject.ref);
      if (parent) {
        return parent.depth + 1;
      }
    }

    return 1;
  };

  return {
    async ask(from, q): Promise<AnswerState> {
      const asker = await askingItem(from, q.workItemId);
      const route = routeQuestion({
        from,
        to: q.to,
        people: opts.team.people,
        load: await loadByPerson(store),
      });

      if (!route.ok) {
        throw new ProtocolError(route.code, route.message);
      }

      const depth = await depthOf(asker);
      if (depth > maxDepth) {
        throw new ProtocolError(
          "invalid",
          `Questions are already ${maxDepth} deep; decide yourself or ask a human.`,
        );
      }

      const target = route.handle;
      const conversation = await store.createConversation({
        askerItemId: asker.id,
        target,
        question: q.question,
        depth,
      });

      const child = await scheduler.enqueue({
        person: target,
        kind: QUESTION_KIND,
        title: `Question from ${from}: ${firstLine(q.question)}`,
        trigger: "agent",
        parentId: asker.id,
        subject: { type: CONVERSATION_SUBJECT, ref: conversation.id },
      });

      await store.appendJournal(
        child.id,
        from,
        questionBrief(conversation.id, from, roleOf(from), asker, q.question),
      );

      const where = await mirrorTo(
        asker,
        `${from} asks ${target} (question ${conversation.id}): ${q.question}`,
      );

      await store.appendJournal(
        asker.id,
        "office",
        `Asked ${target} (question ${conversation.id}): ${q.question}\nMirrored to ${where}.`,
      );

      opts.notify?.(target);
      log.info("question routed", { id: conversation.id, from, to: target, depth });
      return { id: conversation.id, to: target, status: "pending" };
    },

    async answer(from, questionId, text) {
      const conversation = await store.getConversation(questionId);
      if (!conversation) {
        throw new ProtocolError("not_found", `No question ${questionId}.`);
      }

      if (conversation.target !== from) {
        throw new ProtocolError("invalid", `Question ${questionId} was not asked to you.`);
      }

      if (conversation.status === "answered") {
        throw new ProtocolError("invalid", `Question ${questionId} is already answered.`);
      }

      const asker = await store.getItem(conversation.askerItemId);
      if (!asker) {
        throw new ProtocolError("failed", `The item that asked question ${questionId} is gone.`);
      }

      await store.answerConversation(questionId, text);
      await store.appendJournal(
        asker.id,
        from,
        `${from} answered question ${questionId} (${conversation.question}):\n${text}`,
      );

      const where = await mirrorTo(
        asker,
        `${from} answers ${asker.person} (question ${questionId}): ${text}`,
      );

      await store.appendJournal(asker.id, "office", `Answer mirrored to ${where}.`);

      // A running asker cannot take the answer now; `onHandBack` delivers it when the asker stops.
      if (asker.status !== "active") {
        await resume(asker, from);
        await store.markDelivered(questionId);
        opts.notify?.(asker.person);
      }

      log.info("question answered", { id: questionId, from, asker: asker.id });
    },

    async onHandBack(itemId, status) {
      if (!RESUMING.has(status)) {
        return;
      }

      const pending = await store.listUndelivered(itemId);
      const item = pending.length > 0 ? await store.getItem(itemId) : undefined;
      if (!item || item.status === "active") {
        return;
      }

      await store.appendJournal(item.id, "office", lateAnswers(pending));

      await resume(item, [...new Set(pending.map((c) => c.target))].join(", "));
      for (const c of pending) {
        await store.markDelivered(c.id);
      }

      opts.notify?.(item.person);
      log.info("answers delivered after hand-back", { item: item.id, count: pending.length });
    },

    roster: async () =>
      readRoster({
        store,
        team: opts.team,
        ...(opts.roles ? { roles: opts.roles } : {}),
        ...(opts.humans ? { humans: opts.humans } : {}),
        ...(opts.usage ? { usage: opts.usage } : {}),
      }),
  };

  /**
   * Gets the asker's work going again. A waiting item is queued again and continues its session; a finished one gets
   * a follow-up item that takes over the session. An item that is queued, running or blocked keeps its place and
   * sees the answer in its journal the next time it runs.
   */
  async function resume(asker: WorkItem, from: string): Promise<WorkItem> {
    if (asker.status === "waiting") {
      return store.updateItem(asker.id, { status: "queued" });
    }

    if (asker.status === "done" || asker.status === "canceled") {
      const followUp = await scheduler.enqueue({
        person: asker.person,
        kind: asker.kind,
        title: `Answer from ${from}: ${asker.title}`,
        trigger: "agent",
        parentId: asker.id,
        ...(asker.subject ? { subject: asker.subject } : {}),
      });

      return store.updateItem(followUp.id, {
        sessionId: asker.sessionId,
        workspace: asker.workspace,
      });
    }

    return asker;
  }
}

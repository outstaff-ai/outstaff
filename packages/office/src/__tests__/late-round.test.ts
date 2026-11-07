import { describe, expect, it } from "vitest";
import { readOrigin } from "#/chat/origin.js";
import { harness } from "#/messaging/__tests__/test-support.js";
import { createOfficeRounds } from "#/office-rounds.js";
import type { WorkItem } from "#/store/types.js";
import {
  addFeedback,
  deliverFeedback,
  readFeedback,
  undeliveredFeedback,
} from "#/work-feedback.js";

/**
 * sam's item asks mira and noor and is offered its feedback; while it runs, a human writes in chat and the answers
 * come. The hand-back's rounds then run as the office runs them.
 */
async function setup(opts: { answered?: boolean; chat?: boolean; kind?: string } = {}) {
  const { answered = true, chat = true, kind = "ticket" } = opts;
  const h = await harness();
  const logged: string[] = [];
  const rounds = createOfficeRounds({
    store: h.store,
    scheduler: h.scheduler,
    workState: { ticket: () => undefined },
    team: h.team,
    logger: { info: (m) => void logged.push(m) },
    notify: (p) => h.notified.push(p),
  });

  const item = await h.startItem("sam", { type: "ticket", ref: "ACME-1" }, kind);
  await h.store.updateItem(item.id, { sessionId: "sess-1" });
  await h.store.upsertSubject("chat_origin", item.id, {
    channel: "D1",
    thread: "m1",
    requester: { id: "U1" },
    direct: true,
    participant: true,
    claimed: ["result:1"],
  });

  await deliverFeedback(h.store, item.id);
  const q1 = await h.messaging.ask("sam", { to: "mira", question: "One?", workItemId: item.id });
  const q2 = await h.messaging.ask("sam", { to: "noor", question: "Two?", workItemId: item.id });
  if (chat) {
    await addFeedback(h.store, item.id, { actor: "U1", kind: "chat", body: "Go with plan B." });
  }

  if (answered) {
    await h.messaging.answer("mira", q1.id, "Answer one.");
    await h.messaging.answer("noor", q2.id, "Answer two.");
  }

  h.notified.length = 0;
  const handBack = async (status: "done" | "waiting" | "blocked") => {
    if (status === "blocked") {
      await h.scheduler.block(item.id, "stuck");
    } else {
      await h.scheduler.finish(item.id, { outcome: status, status });
    }

    await rounds.followUp(item.id);
  };

  const queued = () => h.store.listItems({ person: "sam", status: "queued" });
  const text = async (i: WorkItem) =>
    (await h.store.readJournal(i.id)).map((j) => j.text).join("\n");

  return { h, item, q1, q2, rounds, logged, handBack, queued, text };
}

describe("one round for what reached an item while it ran", () => {
  it("queues a waiting item again with both its late feedback and its answers, and nothing else", async () => {
    const { h, item, rounds, handBack, queued, text, logged } = await setup();
    await handBack("waiting");
    expect((await queued()).map((i) => i.id)).toEqual([item.id]);
    expect(await text(item)).toContain("Answers that arrived while you were working");
    expect(await text(item)).toContain("Answer two.");
    expect(await h.store.listUndelivered(item.id)).toEqual([]);
    expect((await undeliveredFeedback(h.store, item.id)).map((f) => f.body)).toEqual([
      "Go with plan B.",
    ]);

    expect(h.notified).toEqual(["sam"]);
    expect(logged).toEqual([
      `queued work item ${item.id} for sam again: 1 new feedback and 2 answers while it ran`,
    ]);

    // A repeated hand-back finds it queued and adds nothing.
    await rounds.followUp(item.id);
    expect(await queued()).toHaveLength(1);
    expect(h.notified).toEqual(["sam"]);
  });

  it("gives a finished item one follow-up that carries the feedback and the answers in its session", async () => {
    const { h, item, rounds, handBack, queued, text } = await setup();
    await handBack("done");
    await rounds.followUp(item.id);
    const [next, ...more] = await queued();
    expect(more).toEqual([]);
    expect(next).toMatchObject({
      parentId: item.id,
      kind: item.kind,
      title: item.title,
      sessionId: "sess-1",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect((await readFeedback(h.store, next!.id)).map((f) => f.body)).toEqual(["Go with plan B."]);
    expect(await text(next!)).toContain("Answer one.");
    expect(await text(next!)).toContain("Answer two.");
    expect(await readOrigin(h.store, next!.id)).toMatchObject({ thread: "m1", claimed: [] });
    expect(await h.store.listUndelivered(item.id)).toEqual([]);
  });

  it("still resumes a waiting item for answers alone", async () => {
    const { item, handBack, queued } = await setup({ chat: false });
    await handBack("waiting");
    expect((await queued()).map((i) => i.id)).toEqual([item.id]);
  });

  it("still starts an answer follow-up of a finished item for answers alone, in its session", async () => {
    const { h, item, handBack, queued, text } = await setup({ chat: false });
    await handBack("done");
    const [next, ...more] = await queued();
    expect(more).toEqual([]);
    expect(next).toMatchObject({
      parentId: item.id,
      title: `Answer from mira, noor: ${item.title}`,
      trigger: "agent",
      sessionId: "sess-1",
    });

    expect(await text(next!)).toContain("Answer one.");
    expect(await readOrigin(h.store, next!.id)).toBeUndefined();
  });

  it("gives a chat session's answer follow-up its thread, so the answer reaches the requester", async () => {
    const { h, item, handBack, queued } = await setup({ chat: false, kind: "chat" });
    await handBack("done");
    const [next, ...more] = await queued();
    expect(more).toEqual([]);
    expect(next).toMatchObject({ parentId: item.id, kind: "chat", sessionId: "sess-1" });
    expect(await readOrigin(h.store, next!.id)).toMatchObject({
      channel: "D1",
      thread: "m1",
      claimed: [],
    });
  });

  it("still gives late feedback alone one follow-up", async () => {
    const { h, item, rounds, handBack, queued } = await setup({ answered: false });
    await handBack("done");
    await rounds.followUp(item.id);
    const [next, ...more] = await queued();
    expect(more).toEqual([]);
    expect(next).toMatchObject({ parentId: item.id, title: item.title, sessionId: null });
    expect((await readFeedback(h.store, next!.id)).map((f) => f.body)).toEqual(["Go with plan B."]);
  });

  it("keeps the answers of a blocked item in its journal, and gives its feedback a follow-up", async () => {
    const { h, item, handBack, queued } = await setup();
    await handBack("blocked");
    const [next, ...more] = await queued();
    expect(more).toEqual([]);
    expect(next?.parentId).toBe(item.id);
    expect(await h.store.listUndelivered(item.id)).toHaveLength(2);
  });

  it("takes nothing while the item still runs, or for an unknown one", async () => {
    const { h, item, rounds, queued } = await setup();
    await rounds.followUp(item.id);
    await rounds.followUp("missing");
    expect(await queued()).toEqual([]);
    expect(await h.store.listUndelivered(item.id)).toHaveLength(2);
  });

  describe("answers that come after the hand-back, before the round starts", () => {
    it("join the feedback follow-up of a finished item", async () => {
      const { h, item, q1, q2, handBack, queued, text } = await setup({ answered: false });
      await handBack("done");
      const [next] = await queued();
      await h.messaging.answer("mira", q1.id, "Answer one.");
      await h.messaging.answer("noor", q2.id, "Answer two.");
      expect((await queued()).map((i) => i.id)).toEqual([next!.id]);
      const joined = (await h.store.getItem(next!.id))!;
      expect(joined.sessionId).toBe("sess-1");
      expect(await text(joined)).toContain("Answer one.");
      expect(await text(joined)).toContain("Answer two.");
      expect(await h.store.listUndelivered(item.id)).toEqual([]);
    });

    it("find a waiting item already queued again for its feedback", async () => {
      const { h, item, q1, handBack, queued, text } = await setup({ answered: false });
      await handBack("waiting");
      await h.messaging.answer("mira", q1.id, "Answer one.");
      expect((await queued()).map((i) => i.id)).toEqual([item.id]);
      expect(await text(item)).toContain("Answer one.");
    });

    it("start a new follow-up once the first one has started", async () => {
      const { h, item, q1, handBack, queued } = await setup({ answered: false });
      await handBack("done");
      const [first] = await queued();
      await h.scheduler.markActive(first!.id);
      await h.messaging.answer("mira", q1.id, "Answer one.");
      const [next, ...more] = await queued();
      expect(more).toEqual([]);
      expect(next).toMatchObject({ parentId: item.id, title: `Answer from mira: ${item.title}` });
    });
  });

  it("lets late feedback join the answer follow-up an answer queued during the hand-back", async () => {
    const { h, item, q1, rounds, queued } = await setup({ answered: false });
    await h.scheduler.finish(item.id, { outcome: "done", status: "done" });
    await h.messaging.answer("mira", q1.id, "Answer one.");
    const [next] = await queued();
    await rounds.followUp(item.id);
    expect((await queued()).map((i) => i.id)).toEqual([next!.id]);
    expect((await readFeedback(h.store, next!.id)).map((f) => f.body)).toEqual(["Go with plan B."]);
    expect(await readOrigin(h.store, next!.id)).toMatchObject({ thread: "m1" });

    // Carried once: a repeated hand-back adds nothing more.
    await rounds.followUp(item.id);
    expect(await readFeedback(h.store, next!.id)).toHaveLength(1);
  });
});

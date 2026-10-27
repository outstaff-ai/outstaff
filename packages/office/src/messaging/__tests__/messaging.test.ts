import { createFakeChat } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { ProtocolError } from "../../protocol/errors.js";
import { harness } from "./test-support.js";

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as ProtocolError;
  }

  throw new Error("expected a rejection");
};

describe("routing a question", () => {
  it("goes to a person by handle", async () => {
    const h = await harness();
    const item = await h.startItem("sam");
    const r = await h.messaging.ask("sam", {
      to: "noor",
      question: "Can you review?",
      workItemId: item.id,
    });

    expect(r).toMatchObject({ to: "noor", status: "pending" });
    const [child] = await h.store.listItems({ person: "noor", status: "queued" });
    expect(child).toMatchObject({
      kind: "question",
      trigger: "agent",
      parentId: item.id,
      subject: { type: "conversation", ref: r.id },
    });

    expect(await h.store.getConversation(r.id)).toMatchObject({
      askerItemId: item.id,
      target: "noor",
      depth: 1,
      status: "open",
    });

    expect((await h.store.readJournal(child!.id))[0]?.text).toContain(`ost answer ${r.id} `);
    expect(h.notified).toEqual(["noor"]);
  });

  it("goes to the least busy person with the role", async () => {
    const h = await harness();
    const asker = await h.startItem("noor");
    // mira has two queued items, lena one.
    for (const [p, n] of [
      ["mira", 2],
      ["lena", 1],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await h.scheduler.enqueue({ person: p, kind: "ticket", title: "t", trigger: "human" });
      }
    }

    const r = await h.messaging.ask("noor", {
      to: "architect",
      question: "Which way?",
      workItemId: asker.id,
    });

    expect(r.to).toBe("lena");
  });

  it("counts the active item as load and breaks ties by team order", async () => {
    const h = await harness();
    const asker = await h.startItem("noor");
    await h.startItem("lena");
    const r = await h.messaging.ask("noor", {
      to: "architect",
      question: "Which way?",
      workItemId: asker.id,
    });

    expect(r.to).toBe("mira");
  });

  it("asks a peer: the asker is excluded from their own role", async () => {
    const h = await harness();
    const asker = await h.startItem("sam");
    const r = await h.messaging.ask("sam", {
      to: "developer",
      question: "Pair?",
      workItemId: asker.id,
    });

    expect(r.to).toBe("kit");
  });

  it("says so when the asker is the only one with the role", async () => {
    const h = await harness();
    const asker = await h.startItem("noor");
    const err = await rejection(
      h.messaging.ask("noor", { to: "reviewer", question: "Second look?", workItemId: asker.id }),
    );

    expect(err).toMatchObject({
      code: "not_found",
      message: "no other reviewer on this team; ask a human",
    });
  });

  it("answers a missing role explicitly and creates nothing", async () => {
    const h = await harness();
    const asker = await h.startItem("sam");
    const err = await rejection(
      h.messaging.ask("sam", { to: "devops", question: "Deploy?", workItemId: asker.id }),
    );

    expect(err).toMatchObject({
      code: "not_found",
      message: "no devops on this team; ask a human",
    });

    expect(await h.store.listItems({ status: "queued" })).toEqual([]);
  });

  it("refuses to ask yourself and to ask outside a work item", async () => {
    const h = await harness();
    const asker = await h.startItem("sam");
    expect(
      await rejection(h.messaging.ask("sam", { to: "sam", question: "?", workItemId: asker.id })),
    ).toMatchObject({ code: "invalid" });

    expect(await rejection(h.messaging.ask("sam", { to: "noor", question: "?" }))).toMatchObject({
      code: "invalid",
    });

    expect(
      await rejection(h.messaging.ask("noor", { to: "mira", question: "?", workItemId: asker.id })),
    ).toMatchObject({ code: "unknown_item" });
  });
});

describe("depth limit", () => {
  it("refuses a question beyond the maximum depth", async () => {
    const h = await harness({ maxDepth: 2 });
    const root = await h.startItem("sam");
    const q1 = await h.messaging.ask("sam", { to: "mira", question: "one", workItemId: root.id });
    const [c1] = await h.store.listItems({ person: "mira", status: "queued" });
    await h.scheduler.markActive(c1!.id);
    const q2 = await h.messaging.ask("mira", { to: "noor", question: "two", workItemId: c1!.id });
    expect((await h.store.getConversation(q2.id))?.depth).toBe(2);
    expect((await h.store.getConversation(q1.id))?.depth).toBe(1);
    const [c2] = await h.store.listItems({ person: "noor", status: "queued" });
    await h.scheduler.markActive(c2!.id);
    const err = await rejection(
      h.messaging.ask("noor", { to: "lena", question: "three", workItemId: c2!.id }),
    );

    expect(err).toMatchObject({ code: "invalid" });
    expect(err.message).toContain("2 deep");
    expect(await h.store.listItems({ person: "lena" })).toEqual([]);
  });

  it("defaults to three levels", async () => {
    const h = await harness();
    let item = await h.startItem("sam");
    let asker = "sam";
    for (const to of ["mira", "noor", "kit"]) {
      await h.messaging.ask(asker, { to, question: "q", workItemId: item.id });
      const [next] = await h.store.listItems({ person: to, status: "queued" });
      const started = await h.scheduler.markActive(next!.id);
      if (!started.started) {
        throw new Error(started.detail);
      }

      item = started.item;
      asker = to;
    }

    await expect(
      h.messaging.ask(asker, { to: "lena", question: "q", workItemId: item.id }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("answering", () => {
  const asked = async (opts: Parameters<typeof harness>[0] = {}) => {
    const h = await harness(opts);
    const item = await h.startItem("sam", { type: "ticket", ref: "ACME-1" });
    const q = await h.messaging.ask("sam", {
      to: "mira",
      question: "Which queue?",
      workItemId: item.id,
    });

    return { h, item, q };
  };

  it("lets only the target answer, and only once", async () => {
    const { h, q } = await asked();
    expect(await rejection(h.messaging.answer("noor", q.id, "x"))).toMatchObject({
      code: "invalid",
    });

    expect(await rejection(h.messaging.answer("sam", q.id, "x"))).toMatchObject({
      code: "invalid",
    });

    expect(await rejection(h.messaging.answer("mira", "nope", "x"))).toMatchObject({
      code: "not_found",
    });

    await h.messaging.answer("mira", q.id, "Use the fast one.");
    expect(await rejection(h.messaging.answer("mira", q.id, "again"))).toMatchObject({
      code: "invalid",
    });

    expect(await h.store.getConversation(q.id)).toMatchObject({
      status: "answered",
      answer: "Use the fast one.",
    });
  });

  it("resumes a waiting asker with the answer in its journal", async () => {
    const { h, item, q } = await asked();
    await h.scheduler.finish(item.id, { outcome: "waiting for mira", status: "waiting" });
    h.notified.length = 0;
    await h.messaging.answer("mira", q.id, "Use the fast one.");
    const after = await h.store.getItem(item.id);
    expect(after?.status).toBe("queued");
    const journal = await h.store.readJournal(item.id);
    expect(journal.some((j) => j.author === "mira" && j.text.includes("Use the fast one."))).toBe(
      true,
    );

    expect(h.notified).toEqual(["sam"]);
    expect((await h.scheduler.next("sam"))?.id).toBe(item.id);
  });

  it("keeps the journal only while the asker is still running", async () => {
    const { h, item, q } = await asked();
    await h.messaging.answer("mira", q.id, "Use the fast one.");
    expect((await h.store.getItem(item.id))?.status).toBe("active");
    expect(
      (await h.store.readJournal(item.id)).some((j) => j.text.includes("Use the fast one.")),
    ).toBe(true);
  });

  it("starts a follow-up in the same session when the asker already finished", async () => {
    const { h, item, q } = await asked();
    await h.store.updateItem(item.id, { sessionId: "sess-1" });
    await h.scheduler.finish(item.id, { outcome: "done", status: "done" });
    await h.messaging.answer("mira", q.id, "Use the fast one.");
    const [follow] = await h.store.listItems({ person: "sam", status: "queued" });
    expect(follow).toMatchObject({
      parentId: item.id,
      sessionId: "sess-1",
      subject: { type: "ticket", ref: "ACME-1" },
    });
  });
});

describe("answers that arrive while the asker is running", () => {
  const setup = async () => {
    const h = await harness();
    const item = await h.startItem("sam");
    const q1 = await h.messaging.ask("sam", { to: "mira", question: "One?", workItemId: item.id });
    const q2 = await h.messaging.ask("sam", { to: "noor", question: "Two?", workItemId: item.id });
    await h.messaging.answer("mira", q1.id, "Answer one.");
    await h.messaging.answer("noor", q2.id, "Answer two.");
    return { h, item, q1, q2 };
  };

  it("waits, undelivered, while the asker is active", async () => {
    const { h, item } = await setup();
    expect((await h.store.getItem(item.id))?.status).toBe("active");
    expect(await h.store.listUndelivered(item.id)).toHaveLength(2);
  });

  it("requeues the asker at hand-back with every answer in its journal", async () => {
    const { h, item } = await setup();
    h.notified.length = 0;
    await h.scheduler.finish(item.id, { outcome: "waiting", status: "waiting" });
    await h.messaging.onHandBack(item.id, "waiting");
    expect((await h.store.getItem(item.id))?.status).toBe("queued");
    expect(await h.store.listUndelivered(item.id)).toEqual([]);
    const text = (await h.store.readJournal(item.id)).map((j) => j.text).join("\n");
    expect(text).toContain("arrived while you were working");
    expect(text).toContain("Answer one.");
    expect(text).toContain("Answer two.");
    expect(h.notified).toEqual(["sam"]);

    // Delivered once: a second hand-back does nothing.
    await h.messaging.onHandBack(item.id, "waiting");
    expect(h.notified).toEqual(["sam"]);
  });

  it("does nothing while the item is still active, for blocked hand-backs, or without answers", async () => {
    const { h, item } = await setup();
    await h.messaging.onHandBack(item.id, "waiting");
    expect(await h.store.listUndelivered(item.id)).toHaveLength(2);
    await h.messaging.onHandBack(item.id, "blocked");
    expect(await h.store.listUndelivered(item.id)).toHaveLength(2);
    await h.messaging.onHandBack("missing", "waiting");
  });

  it("starts a follow-up when the asker handed back as done", async () => {
    const { h, item } = await setup();
    await h.scheduler.finish(item.id, { outcome: "done", status: "done" });
    await h.messaging.onHandBack(item.id, "done");
    const [follow] = await h.store.listItems({ person: "sam", status: "queued" });
    expect(follow?.parentId).toBe(item.id);
  });
});

describe("loop guard", () => {
  it("blocks a resumed asker that keeps cycling through questions", async () => {
    const h = await harness({ maxRuns: 2 });
    const root = await h.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "t",
      trigger: "agent",
    });

    let started = await h.scheduler.markActive(root.id);
    for (let round = 0; round < 2; round++) {
      expect(started).toMatchObject({ started: true });
      const q = await h.messaging.ask("sam", {
        to: "mira",
        question: "again?",
        workItemId: root.id,
      });

      await h.scheduler.finish(root.id, { outcome: "waiting", status: "waiting" });
      await h.messaging.answer("mira", q.id, "yes");
      started = await h.scheduler.markActive(root.id);
    }

    expect(started).toMatchObject({ started: false, reason: "loop_guard" });
    expect((await h.store.getItem(root.id))?.status).toBe("blocked");
  });
});

describe("mirroring", () => {
  it("posts to the team channel when the chat adapter and channel exist", async () => {
    const chat = createFakeChat();
    const h2 = await harness({ chat, channel: "C-team" });
    const item = await h2.startItem("sam", { type: "ticket", ref: "ACME-1" });
    const q = await h2.messaging.ask("sam", {
      to: "mira",
      question: "Which queue?",
      workItemId: item.id,
    });

    await h2.messaging.answer("mira", q.id, "The fast one.");
    expect(chat.posts.map((m) => [m.channel, m.text])).toEqual([
      ["C-team", `sam asks mira (question ${q.id}): Which queue?`],
      ["C-team", `mira answers sam (question ${q.id}): The fast one.`],
    ]);
  });

  it("reads the channel from office.channel in team.yaml", async () => {
    const h = await harness({ office: { channel: "C-team" } });
    const messaging = (await import("../messaging.js")).createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      chat: h.chat,
    });

    const item = await h.startItem("sam");
    await messaging.ask("sam", { to: "mira", question: "Q?", workItemId: item.id });
    expect(h.chat.posts[0]?.channel).toBe("C-team");
  });

  it("comments on the ticket when there is no channel", async () => {
    const h = await harness();
    const issue = await h.tracker.createIssue({ title: "Cart", body: "" });
    const m = (await import("../messaging.js")).createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      chat: h.chat,
      tracker: h.tracker,
    });

    const item = await h.startItem("sam", { type: "ticket", ref: issue.key });
    const q = await m.ask("sam", { to: "mira", question: "Which queue?", workItemId: item.id });
    await m.answer("mira", q.id, "The fast one.");
    const comments = await h.tracker.listComments(issue.key);
    expect(comments.map((c) => c.body)).toEqual([
      `sam asks mira (question ${q.id}): Which queue?`,
      `mira answers sam (question ${q.id}): The fast one.`,
    ]);

    expect(h.chat.posts).toEqual([]);
  });

  it("falls back to the journal, and says where the text went", async () => {
    const h = await harness();
    const item = await h.startItem("sam");
    await h.messaging.ask("sam", { to: "mira", question: "Which queue?", workItemId: item.id });
    const journal = await h.store.readJournal(item.id);
    expect(journal.at(-1)?.text).toContain("Mirrored to the work journal only.");
  });

  it("falls through when the channel or the tracker fails", async () => {
    const h = await harness();
    const issue = await h.tracker.createIssue({ title: "Cart", body: "" });
    const failing = { ...h.chat, post: () => Promise.reject(new Error("down")) };
    const m = (await import("../messaging.js")).createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      chat: failing,
      channel: "C-team",
      tracker: h.tracker,
    });

    const item = await h.startItem("sam", { type: "ticket", ref: issue.key });
    await m.ask("sam", { to: "mira", question: "Q?", workItemId: item.id });
    expect(await h.tracker.listComments(issue.key)).toHaveLength(1);
    const brokenTracker = { ...h.tracker, comment: () => Promise.reject(new Error("down")) };
    const m2 = (await import("../messaging.js")).createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      tracker: brokenTracker,
    });

    const item2 = await h.startItem("kit", { type: "ticket", ref: issue.key });
    await expect(
      m2.ask("kit", { to: "noor", question: "Q2?", workItemId: item2.id }),
    ).resolves.toMatchObject({ to: "noor" });

    expect((await h.store.readJournal(item2.id)).at(-1)?.text).toContain("work journal only");
  });
});

describe("roster", () => {
  it("shows people with role, busy or idle, and the humans", async () => {
    const roles = new Map([["architect", { title: "Architect", summary: "Designs the system." }]]);
    const h = await harness({ roles });
    await h.startItem("mira");
    await h.scheduler.pause("kit", "vacation");
    const { members, humans } = await h.messaging.roster();
    const by = Object.fromEntries(members.map((m) => [m.handle, m]));
    expect(by["mira"]).toMatchObject({
      role: "architect",
      title: "Architect",
      summary: "Designs the system.",
      status: "working",
      current: "Work of mira",
    });

    expect(by["lena"]).toMatchObject({ status: "idle" });
    expect(by["kit"]).toMatchObject({ status: "paused" });
    expect(by["sam"]).toMatchObject({ title: "developer" });
    expect(by["sam"]?.summary).toBeUndefined();
    expect(humans).toEqual([{ name: "Ada Admin" }]);
  });

  it("shows a hire at once", async () => {
    const h = await harness();
    h.team.people.push({ handle: "zoe", name: "Zoe", role: "devops", repos: {} });
    expect((await h.messaging.roster()).members.map((m) => m.handle)).toContain("zoe");
    const asker = await h.startItem("sam");
    expect(
      (await h.messaging.ask("sam", { to: "devops", question: "?", workItemId: asker.id })).to,
    ).toBe("zoe");
  });
});

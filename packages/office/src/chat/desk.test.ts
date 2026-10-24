import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeChat, createFakeTracker } from "@outstaff/core/fakes";
import { beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../clock.js";
import { createScheduler } from "../scheduler/scheduler.js";
import { openStore } from "../store/index.js";
import type { Store, WorkItem } from "../store/types.js";
import { createChatDesk, type ChatRequests } from "./desk.js";
import { readOrigin } from "./origin.js";
import { parsePlacement } from "./placement.js";

function teamConfig(withPm = true): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { chat: "U0DANA0001" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      { handle: "sam", name: "Sam", role: "developer", identities: { tracker: "u-2" } },
      ...(withPm ? [{ handle: "pat", name: "Pat", role: "pm" }] : []),
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  if (!cond()) {
    throw new Error("condition not reached");
  }
};

const DANA = { id: "U0DANA0001", name: "Dana" };

describe("chat requests", () => {
  let store: Store;
  let desk: ChatRequests;
  let scheduler: ReturnType<typeof createScheduler>;
  let tracker: ReturnType<typeof createFakeTracker>;
  let chat: ReturnType<typeof createFakeChat>;
  let notified: string[];
  let asked: { to: string; question: string; workItemId?: string | undefined }[];
  let n: number;
  let clock: ManualClock;
  let makeDesk: (withChat?: boolean) => ChatRequests;

  const say = (text: string, thread?: string, messageId = `m${++n}`) =>
    desk.message("sam", {
      messageId,
      channel: "D1",
      text,
      author: DANA,
      ...(thread ? { thread } : {}),
    });

  const busyWith = async (...titles: string[]) => {
    const items: WorkItem[] = [];
    for (const title of titles) {
      items.push(
        await scheduler.enqueue({ person: "sam", kind: "ticket", title, trigger: "human" }),
      );
    }

    const started = await scheduler.markActive(items[0]!.id);
    if (!started.started) {
      throw new Error(started.detail);
    }

    return items;
  };

  const queueOrder = async () =>
    (await store.listItems({ person: "sam", status: "queued" }))
      .toSorted((a, b) => a.priority - b.priority || a.position - b.position)
      .map((i) => i.title);

  beforeEach(async () => {
    n = 0;
    notified = [];
    asked = [];
    clock = manualClock();
    const team = teamConfig();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    scheduler = createScheduler({ store, team, clock });
    tracker = createFakeTracker({ now: clock.now });
    await tracker.seed.member({ name: "Sam", kind: "agent" });
    chat = createFakeChat({ now: clock.now });
    makeDesk = (withChat = true) =>
      createChatDesk({
        clock,
        store,
        scheduler,
        team,
        workState: {
          currentWork: (person) => ({
            person,
            tickets: [{ key: "ACME-9", title: "Old work", status: "active", prs: [] }],
            prs: [],
          }),
        },
        tracker,
        ...(withChat ? { chat } : {}),
        messaging: {
          async ask(_from, q) {
            asked.push(q);
            return { id: "q1", to: "pat", status: "pending" };
          },
        },
        linksOf: async (item) =>
          item.subject?.type === "ticket"
            ? [{ url: tracker.links.issue(item.subject.ref), title: item.subject.ref }]
            : [],
        notify: (p) => notified.push(p),
      });

    desk = makeDesk();
  });

  describe("a result the agent did not post", () => {
    const finished = async (summary = "The search page is up.\nSecond line.\nThird line.") => {
      const r = await say("please add a search page");
      await scheduler.markActive(r.item.id);
      const item = await scheduler.finish(r.item.id, { outcome: summary, status: "done" });
      const link = { url: "https://git.acme.example/acme/app/pull/4", title: "PR 4" };
      await desk.handedBack(item, { summary, links: [link] });
      return item;
    };

    it("posts it once, mentioning the requester, after the grace period", async () => {
      await finished();
      clock.advance(59_000);
      expect(chat.posts).toEqual([]);

      clock.advance(1_000);
      await until(() => chat.posts.length === 1);
      const [post] = chat.posts;
      expect(post).toMatchObject({ channel: "D1", thread: "m1" });
      expect(post!.text).toContain("<@U0DANA0001> The search page is up.");
      expect(post!.text).toContain("offline");
      expect(post!.text).toContain("https://git.acme.example/acme/app/pull/4");
      expect(post!.text).not.toContain("Third line");

      clock.advance(600_000);
      expect(chat.posts).toHaveLength(1);
    });

    it("stays quiet when the agent claimed the report in time, and refuses a late claim after the office posted", async () => {
      const item = await finished();
      expect(await desk.report("sam", item.id, "result")).toMatchObject({ post: true });
      clock.advance(60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chat.posts).toEqual([]);

      const second = await say("another one");
      await scheduler.markActive(second.item.id);
      const done = await scheduler.finish(second.item.id, { outcome: "Done.", status: "done" });
      await desk.handedBack(done, { summary: "Done.", links: [] });
      clock.advance(60_000);
      await until(() => chat.posts.length === 1);
      expect(await desk.report("sam", done.id, "result")).toEqual({ post: false, links: [] });
      expect(chat.posts).toHaveLength(1);
    });

    it("resumes after a restart from the hand-back time and still posts once", async () => {
      await finished();
      clock.advance(40_000);
      desk.stop();

      const restarted = makeDesk();
      await restarted.resume();
      clock.advance(19_000);
      expect(chat.posts).toEqual([]);

      clock.advance(1_000);
      await until(() => chat.posts.length === 1);
      await restarted.resume();
      clock.advance(120_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chat.posts).toHaveLength(1);
    });

    it("leaves the result alone without a chat port", async () => {
      desk = makeDesk(false);
      await finished();
      expect(clock.pending()).toBe(0);
    });
  });

  it("starts an idle person's request at once without filing a ticket", async () => {
    const r = await say("why is CI failing?");
    expect(r).toMatchObject({ disposition: "started", repeated: false, links: [], work: [] });
    expect(notified).toEqual(["sam"]);

    const item = (await store.getItem(r.item.id))!;
    expect(item).toMatchObject({
      kind: "chat",
      trigger: "human",
      priority: 0,
      subject: { type: "chat", ref: "D1:m1" },
    });

    expect((await scheduler.next("sam"))?.id).toBe(item.id);
    expect(await readOrigin(store, item.id)).toMatchObject({
      channel: "D1",
      thread: "m1",
      requester: DANA,
      awaitingPlacement: false,
    });

    expect(await tracker.listIssues({})).toEqual([]);
    expect((await store.readJournal(item.id))[0]!.text).toContain("why is CI failing?");
  });

  describe("ticket", () => {
    it("becomes the subject of the chat item, once", async () => {
      const r = await say("Add a search page");
      await scheduler.markActive(r.item.id);
      expect(await desk.linkTicket("sam", r.item.id, "ACME-5")).toEqual({
        url: tracker.links.issue("ACME-5"),
      });

      expect((await store.getItem(r.item.id))!.subject).toEqual({ type: "ticket", ref: "ACME-5" });
      await expect(desk.linkTicket("sam", r.item.id, "ACME-6")).rejects.toMatchObject({
        code: "invalid",
      });
    });

    it("is refused for other people's items and for items that are not chat requests", async () => {
      const r = await say("Add a search page");
      await expect(desk.linkTicket("pat", r.item.id, "ACME-5")).rejects.toMatchObject({
        code: "unknown_item",
      });

      const plain = await scheduler.enqueue({
        person: "sam",
        kind: "ticket",
        title: "x",
        trigger: "human",
      });

      await expect(desk.linkTicket("sam", plain.id, "ACME-5")).rejects.toMatchObject({
        code: "invalid",
      });
    });
  });

  it("queues a busy person's request last and lists their work", async () => {
    const [running, queued] = await busyWith("Running thing", "Queued thing");
    await store.updateItem(running!.id, {});
    const r = await say("Fix the footer");
    expect(r.disposition).toBe("waiting");
    expect(r.work.map((w) => [w.title, w.status])).toEqual([
      ["Running thing", "active"],
      ["Queued thing", "queued"],
    ]);

    expect(queued).toBeDefined();
    expect(await queueOrder()).toEqual(["Queued thing", "Chat: Fix the footer"]);
    expect(await readOrigin(store, r.item.id)).toMatchObject({ awaitingPlacement: true });
  });

  it.each([
    ["next", ["Chat: Fix the footer", "Queued A", "Queued B"], "next"],
    ["put it first please", ["Chat: Fix the footer", "Queued A", "Queued B"], "next"],
    ["last", ["Queued A", "Queued B", "Chat: Fix the footer"], "last"],
    ["after 2", ["Queued A", "Chat: Fix the footer", "Queued B"], "after Queued A"],
    ["after Queued B", ["Queued A", "Queued B", "Chat: Fix the footer"], "after Queued B"],
    ["after the current one", ["Chat: Fix the footer", "Queued A", "Queued B"], "next"],
  ])("places the waiting request when the requester says %j", async (answer, order, placement) => {
    await busyWith("Running thing", "Queued A", "Queued B");
    const first = await say("Fix the footer");
    expect(await queueOrder()).toEqual(["Queued A", "Queued B", "Chat: Fix the footer"]);
    notified.length = 0;

    const r = await say(answer, "m1");
    expect(r).toMatchObject({ disposition: "placed", placement });
    expect(await queueOrder()).toEqual(order);
    expect(await readOrigin(store, first.item.id)).toMatchObject({ awaitingPlacement: false });
    expect(notified).toEqual(["sam"]);
  });

  it("asks the PM to prioritize when the requester wants that", async () => {
    await busyWith("Running thing", "Queued A");
    await say("Fix the footer");
    const r = await say("can you ask the PM to prioritize it?", "m1");
    expect(r.disposition).toBe("asked_pm");
    expect(asked[0]).toMatchObject({ to: "pm" });
    expect(asked[0]!.question).toContain("Queued A");
    expect(await queueOrder()).toEqual(["Queued A", "Chat: Fix the footer"]);
  });

  it("does not offer the PM when the team has none, and asks again when the answer is unclear", async () => {
    const noPm = createChatDesk({
      store,
      scheduler,
      team: teamConfig(false),
      workState: { currentWork: () => ({ person: "sam", tickets: [], prs: [] }) },
      linksOf: async () => [],
      notify: () => {},
    });

    await busyWith("Running thing");
    await noPm.message("sam", { messageId: "a", channel: "D1", text: "Hi", author: DANA });
    const pm = await noPm.message("sam", {
      messageId: "b",
      channel: "D1",
      thread: "a",
      text: "ask the pm",
      author: DANA,
    });

    expect(pm.disposition).toBe("unclear");
    const vague = await noPm.message("sam", {
      messageId: "c",
      channel: "D1",
      thread: "a",
      text: "hmm let me think",
      author: DANA,
    });

    expect(vague.disposition).toBe("unclear");
    expect(vague.work).toHaveLength(1);
  });

  it("adds a reply in an item's thread to that item", async () => {
    const started = await say("Add a search page");
    await scheduler.markActive(started.item.id);
    const r = await say("also add a clear button", "m1");
    expect(r).toMatchObject({ disposition: "joined", item: { id: started.item.id } });
    const journal = (await store.readJournal(started.item.id)).map((j) => j.text).join("\n");
    expect(journal).toContain("also add a clear button");
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
  });

  it("queues a waiting item again when its thread gets a reply", async () => {
    const started = await say("Add a search page");
    await scheduler.markActive(started.item.id);
    await scheduler.finish(started.item.id, { outcome: "asked", status: "waiting" });
    notified.length = 0;

    const r = await say("use the fast index", "m1");
    expect(r.disposition).toBe("joined");
    expect((await store.getItem(started.item.id))!.status).toBe("queued");
    expect(notified).toEqual(["sam"]);
  });

  it("continues a finished item's thread in a new item with the same session", async () => {
    const started = await say("Add a search page");
    await scheduler.markActive(started.item.id);
    await desk.linkTicket("sam", started.item.id, "ACME-1");
    await store.updateItem(started.item.id, { sessionId: "sess-1" });
    await scheduler.finish(started.item.id, { outcome: "done", status: "done" });

    const r = await say("one more thing: dark mode", "m1");
    expect(r.disposition).toBe("started");
    expect(r.item.id).not.toBe(started.item.id);
    const next = (await store.getItem(r.item.id))!;
    expect(next).toMatchObject({
      parentId: started.item.id,
      sessionId: "sess-1",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect(await readOrigin(store, next.id)).toMatchObject({ thread: "m1" });
    // The ticket of the first request stays with the thread.
  });

  it("treats a reply in an unknown thread as a new request in that thread", async () => {
    const r = await say("please look at this", "t-from-a-human");
    expect(r.disposition).toBe("started");
    expect(await readOrigin(store, r.item.id)).toMatchObject({ thread: "t-from-a-human" });
  });

  it("recognizes a message it handled and does nothing twice", async () => {
    const first = await say("Add a search page", undefined, "same");
    const again = await say("Add a search page", undefined, "same");
    expect(again).toMatchObject({ repeated: true, item: { id: first.item.id } });
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
  });

  describe("report", () => {
    const finished = async (status: "done" | "blocked" = "done") => {
      const r = await say("Add a search page");
      await scheduler.markActive(r.item.id);
      await desk.linkTicket("sam", r.item.id, "ACME-1");
      if (status === "blocked") {
        await scheduler.block(r.item.id, "stuck");
      } else {
        await scheduler.finish(r.item.id, { outcome: "ok", status: "done" });
      }

      return r.item.id;
    };

    it("grants the result once per ending, with the ticket link", async () => {
      const id = await finished();
      const first = await desk.report("sam", id, "result");
      expect(first).toEqual({
        post: true,
        requester: DANA.id,
        links: [{ url: tracker.links.issue("ACME-1"), title: "ACME-1" }],
      });

      expect((await desk.report("sam", id, "result")).post).toBe(false);
    });

    it("grants nothing before the item ended that way, for other people, or without a chat origin", async () => {
      const r = await say("Add a search page");
      expect((await desk.report("sam", r.item.id, "result")).post).toBe(false);
      expect((await desk.report("sam", r.item.id, "blocked")).post).toBe(false);
      await expect(desk.report("pat", r.item.id, "result")).rejects.toMatchObject({
        code: "unknown_item",
      });

      const plain = await scheduler.enqueue({
        person: "sam",
        kind: "ticket",
        title: "x",
        trigger: "human",
      });

      expect((await desk.report("sam", plain.id, "failed")).post).toBe(false);
    });

    it("grants a failure note once and a blocked note once", async () => {
      const id = await finished("blocked");
      expect((await desk.report("sam", id, "failed")).post).toBe(true);
      expect((await desk.report("sam", id, "failed")).post).toBe(false);
      expect((await desk.report("sam", id, "blocked")).post).toBe(true);
      expect((await desk.report("sam", id, "blocked")).post).toBe(false);
    });

    it("tells the thread itself when the scheduler blocked the item, once", async () => {
      const id = await finished("blocked");
      const item = (await store.getItem(id))!;
      await desk.notifyBlocked(item, "Stale again: no heartbeat for 10 minutes on the retry.");
      await desk.notifyBlocked(item, "Stale again: no heartbeat for 10 minutes on the retry.");
      expect(chat.posts).toHaveLength(1);
      expect(chat.posts[0]).toMatchObject({ channel: "D1", thread: "m1" });
      expect(chat.posts[0]!.text).toContain("<@U0DANA0001>");
      expect(chat.posts[0]!.text).toContain(tracker.links.issue("ACME-1"));
      // The agent's own blocked note is now already granted.
      expect((await desk.report("sam", id, "blocked")).post).toBe(false);
    });
  });

  describe("a reply in the thread of a blocked item", () => {
    const blocked = async () => {
      const r = await say("Add a search page");
      await scheduler.markActive(r.item.id);
      await desk.linkTicket("sam", r.item.id, "ACME-1");
      await store.updateItem(r.item.id, {
        sessionId: "s1",
        failures: 3,
        notBefore: "2999-01-01T00:00:00.000Z",
      });

      await store.recordLoopGuard(r.item.id);
      await scheduler.block(r.item.id, "stuck");
      notified.length = 0;
      return r.item.id;
    };

    it("retries it with a clean count and says so in the thread", async () => {
      const id = await blocked();
      const reply = await say("try again please", "m1");
      expect(reply.disposition).toBe("joined");
      expect(await store.getItem(id)).toMatchObject({
        status: "queued",
        failures: 0,
        notBefore: null,
        sessionId: "s1",
      });

      expect(await store.countLoopGuard(id, 60 * 60_000)).toBe(0);
      const journal = (await store.readJournal(id)).map((j) => j.text);
      expect(journal).toContain("Retried on request by Dana (chat reply).");
      expect(journal).toContain("In the chat thread: try again please");
      expect(chat.posts.at(-1)).toMatchObject({
        channel: "D1",
        thread: "m1",
        text: "Retrying ACME-1 on request",
      });

      expect(notified).toEqual(["sam"]);
    });

    it("works for an item of any kind the thread is linked to", async () => {
      const item = await scheduler.enqueue({
        person: "sam",
        kind: "implement",
        title: "Implement: Search",
        trigger: "agent",
        subject: { type: "ticket", ref: "ACME-2" },
      });

      await store.upsertSubject("chat_thread", "D1:t9", { itemId: item.id });
      await scheduler.block(item.id, "stuck");
      await say("go on", "t9");
      expect((await store.getItem(item.id))?.status).toBe("queued");
      expect(chat.posts.at(-1)?.text).toBe("Retrying ACME-2 on request");
    });

    it("leaves a waiting item as it was, without a note", async () => {
      const r = await say("Add a search page");
      await store.updateItem(r.item.id, { status: "waiting" });
      await say("here is more", "m1");
      expect((await store.getItem(r.item.id))?.status).toBe("queued");
      expect(chat.posts).toHaveLength(0);
    });
  });

  it("gives the person's current work as text", async () => {
    expect(await desk.currentWork("sam")).toContain("Ticket ACME-9");
  });
});

describe("parsePlacement", () => {
  const items = [
    { id: "w1", title: "Checkout bug", ticketKey: "ACME-4" },
    { id: "w2", title: "Search page" },
  ];

  it.each([
    ["next", { type: "next" }],
    ["Last, no rush", { type: "last" }],
    ["after #2", { type: "after", itemId: "w2" }],
    ["after acme-4", { type: "after", itemId: "w1" }],
    ["after w2", { type: "after", itemId: "w2" }],
    ["after the search page", { type: "after", itemId: "w2" }],
    ["ask the PM please", { type: "pm" }],
    ["after 7", undefined],
    ["thanks", undefined],
  ])("reads %j", (text, expected) => {
    expect(parsePlacement(text, items)).toEqual(expected);
  });
});

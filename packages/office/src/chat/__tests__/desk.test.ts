import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeTracker } from "@outstaff/core/fakes";
import { beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import { openStore } from "#/store/index.js";
import type { Store, WorkItem } from "#/store/types.js";
import { createChatDesk } from "#/chat/desk.js";
import type { ChatRequests } from "#/chat/desk.types.js";
import { openChatSession } from "#/chat/session.js";
import { readOrigin, threadsOf, withThread } from "#/chat/origin.js";
import type { PrRecord, TicketRecord } from "#/workstate/index.js";
import { addFeedback, readFeedback } from "#/work-feedback.js";

function teamConfig(withPm = true, policies?: Record<string, unknown>): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { chat: "U0DANA0001" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        model: "sonnet",
        identities: { tracker: "u-2" },
      },
      ...(withPm ? [{ handle: "pat", name: "Pat", role: "pm", model: "sonnet" }] : []),
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    ...(policies ? { policies } : {}),
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

const DANA = { id: "U0DANA0001", name: "Dana" };

describe("chat requests", () => {
  let store: Store;
  let desk: ChatRequests;
  let scheduler: ReturnType<typeof createScheduler>;
  let tracker: ReturnType<typeof createFakeTracker>;
  let notified: string[];
  let n: number;
  let clock: ManualClock;
  let makeDesk: (over?: TeamConfig) => ChatRequests;
  let tickets: TicketRecord[];
  let pulls: PrRecord[];
  let workers: Record<string, string>;

  // The office's picture of the work, as the work state keeps it.
  const knownWork = () => ({
    currentWork: (person: string) => ({
      person,
      tickets: [{ key: "ACME-9", title: "Old work", status: "active" as const, prs: [] }],
      prs: pulls
        .filter((p) => p.state === "open" && p.author.person === person)
        .map((p) => ({
          ref: `acme/app#${p.ref.number}`,
          number: p.ref.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          ci: "success" as const,
          mergeable: "clean" as const,
          unresolvedThreads: 0,
          ...(p.ticket ? { ticket: p.ticket } : {}),
        })),
    }),
    pullRequests: (number: number) => pulls.filter((p) => p.ref.number === number),
    ticket: (key: string) => tickets.find((t) => t.key === key),
    lastWorker: (key: string) => workers[key],
    catchUp: async () => {},
    prSubject: (ref: { number: number }) => `acme/app#${ref.number}`,
  });

  /** A message the pipeline woke sam for: a chat session for it, as `chat_to_addressed` queues one. */
  const message = async (m: Parameters<typeof openChatSession>[2]) => {
    const item = await scheduler.enqueue({
      person: "sam",
      kind: "chat",
      title: `Chat: ${m.text}`,
      trigger: "human",
      subject: { type: "chat", ref: `D1:${m.thread ?? m.messageId}` },
      init: (created) => openChatSession(store, created, m),
    });

    return { item };
  };

  const say = (text: string, thread?: string, messageId = `m${++n}`) =>
    message({
      messageId,
      channel: "D1",
      text,
      author: DANA,
      direct: true,
      participant: true,
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

  /** A chat session that decided its message is work and filed it: the session, and the item it filed. */
  const fileWork = async (text = "Fix the footer", ticket?: string) => {
    const session = await say(text);
    await scheduler.markActive(session.item.id);
    const filed = ticket
      ? await desk.linkTicket("sam", session.item.id, ticket, text)
      : await desk.queueWork("sam", session.item.id, { title: text, body: "Asked in chat." });

    return { session: session.item, filed, item: filed.item };
  };

  beforeEach(async () => {
    tickets = [];
    pulls = [];
    workers = {};
    n = 0;
    notified = [];
    clock = manualClock();
    const team = teamConfig();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    scheduler = createScheduler({ store, team, clock });
    tracker = createFakeTracker({ now: clock.now });
    await tracker.seed.member({ name: "Sam", kind: "agent" });
    makeDesk = (over = team) =>
      createChatDesk({
        clock,
        store,
        scheduler,
        team: over,
        workState: knownWork(),
        tracker,
        requesterChat: async () => DANA.id,
        linksOf: async (item) =>
          item.subject?.type === "ticket"
            ? [{ url: tracker.links.issue(item.subject.ref), title: item.subject.ref }]
            : [],
        notify: (p) => notified.push(p),
      });

    desk = makeDesk();
  });

  describe("a report the agent did not post", () => {
    const finished = async (summary = "The search page is up.\nSecond line.\nThird line.") => {
      const r = await say("please add a search page");
      await scheduler.markActive(r.item.id);
      const item = await scheduler.finish(r.item.id, { outcome: summary, status: "done" });
      const link = { url: "https://git.acme.example/acme/app/pull/4", title: "PR 4" };
      await desk.handedBack(item, { summary, links: [link] });
      return item;
    };

    it("is handed to the agent when it connects, until the agent confirms it posted it", async () => {
      const item = await finished();
      const handed = [
        {
          id: expect.any(String),
          workItemId: item.id,
          kind: "result",
          text: "The search page is up.\nSecond line.\nThird line.",
          requester: DANA.id,
          links: [{ url: "https://git.acme.example/acme/app/pull/4", title: "PR 4" }],
          threads: [
            { channel: "D1", thread: "m1", requester: DANA, direct: true, participant: true },
          ],
        },
      ];

      const first = await desk.queued("sam");
      expect(first).toEqual(handed);

      // Not confirmed (the agent died while posting): it is handed over again, with the same id.
      expect(await desk.queued("sam")).toEqual(first);
      await desk.posted("sam", item.id, first[0]!.id);
      expect(await desk.queued("sam")).toEqual([]);

      // Confirming twice is harmless, and a late claim of the same ending is refused.
      await desk.posted("sam", item.id, first[0]!.id);
      expect(await desk.report("sam", item.id, "result")).toEqual({ post: false, links: [] });
    });

    it("keeps whether the requester needs a mention for the agent to decide", async () => {
      const r = await message({
        messageId: "x1",
        text: "please add a search page",
        author: DANA,
        channel: "C1",
        direct: false,
        participant: false,
      });

      await scheduler.markActive(r.item.id);
      const item = await scheduler.finish(r.item.id, { outcome: "Done.", status: "done" });
      await desk.handedBack(item, { summary: "Done.", links: [] });
      const [report] = await desk.queued("sam");
      expect(report!.threads).toEqual([
        { channel: "C1", thread: "x1", requester: DANA, direct: false, participant: false },
      ]);
    });

    it("is not queued when the agent claimed the report in time, and a late claim is refused once it confirmed", async () => {
      const item = await finished();
      expect(await desk.report("sam", item.id, "result")).toMatchObject({ post: true });
      expect(await desk.queued("sam")).toEqual([]);

      const second = await say("another one");
      await scheduler.markActive(second.item.id);
      const done = await scheduler.finish(second.item.id, { outcome: "Done.", status: "done" });
      await desk.handedBack(done, { summary: "Done.", links: [] });
      const [handed] = await desk.queued("sam");
      await desk.posted("sam", done.id, handed!.id);
      expect(await desk.report("sam", done.id, "result")).toEqual({ post: false, links: [] });
    });

    it("survives a restart of the office: the queue is in the store", async () => {
      await finished();
      expect(await makeDesk().queued("sam")).toHaveLength(1);
    });

    it("is dropped when the item was retried and is not at that ending any more", async () => {
      const item = await finished();
      await store.updateItem(item.id, { status: "queued" });
      expect(await desk.queued("sam")).toEqual([]);
    });

    it("is for the person's own agent only", async () => {
      await finished();
      expect(await desk.queued("pat")).toEqual([]);
    });

    it("queues nothing for a session that filed its request as work", async () => {
      const { session } = await fileWork("please add a search page", "ACME-1");
      const done = await scheduler.finish(session.id, { outcome: "filed", status: "done" });
      await desk.handedBack(done, { summary: "Filed ACME-1.", links: [] });
      expect(await desk.queued("sam")).toEqual([]);
    });

    describe("a blocked item", () => {
      const blockedItem = async (over: TeamConfig, ticket = true) => {
        desk = makeDesk(over);
        const item = await scheduler.enqueue({
          person: "sam",
          kind: "assigned",
          title: "Assigned: ACME-3",
          trigger: "human",
          ...(ticket ? { subject: { type: "ticket", ref: "ACME-3" } } : {}),
        });

        await scheduler.markActive(item.id);
        await scheduler.block(item.id, "Need the staging key.");
        const blocked = (await store.getItem(item.id))!;

        await desk.handedBack(blocked, { summary: "Need the staging key.", links: [] });
        return blocked;
      };

      it("goes to the PM when the team has one: the agent reports nothing", async () => {
        const item = await blockedItem(teamConfig(true));
        expect(await desk.report("sam", item.id, "blocked")).toEqual({ post: false, links: [] });
        expect(await desk.queued("sam")).toEqual([]);
      });

      it("is reported by the agent to the requester's direct message without a PM", async () => {
        const item = await blockedItem(teamConfig(false));
        const granted = await desk.report("sam", item.id, "blocked");
        expect(granted).toEqual({
          post: true,
          requester: DANA.id,
          direct: DANA.id,
          links: [{ url: tracker.links.issue("ACME-3"), title: "ACME-3" }],
        });

        expect((await desk.report("sam", item.id, "blocked")).post).toBe(false);
        expect(await desk.queued("sam")).toEqual([]);
      });

      it("is reported by the agent when policies.hand_back.blocked_notify is agent, even with a PM", async () => {
        const item = await blockedItem(
          teamConfig(true, { hand_back: { blocked_notify: "agent" } }),
        );

        expect((await desk.report("sam", item.id, "blocked")).post).toBe(true);
      });

      it("is queued for the agent to post in a direct message when it was offline", async () => {
        await blockedItem(teamConfig(false));
        expect(await desk.queued("sam")).toEqual([
          {
            id: expect.any(String),
            workItemId: expect.any(String),
            kind: "blocked",
            text: "Need the staging key.",
            requester: DANA.id,
            direct: DANA.id,
            links: [{ url: tracker.links.issue("ACME-3"), title: "ACME-3" }],
          },
        ]);
      });

      it("is dropped when nobody can be told: no requester chat identity", async () => {
        desk = createChatDesk({
          clock,
          store,
          scheduler,
          team: teamConfig(false),
          workState: knownWork(),
          requesterChat: async () => undefined,
          linksOf: async () => [],
          notify: () => {},
        });

        const item = await scheduler.enqueue({
          person: "sam",
          kind: "assigned",
          title: "x",
          trigger: "human",
          subject: { type: "ticket", ref: "ACME-3" },
        });

        await scheduler.markActive(item.id);
        await scheduler.block(item.id, "stuck");
        const blocked = (await store.getItem(item.id))!;
        await desk.handedBack(blocked, { summary: "stuck", links: [] });
        expect(await desk.report("sam", blocked.id, "blocked")).toEqual({ post: false, links: [] });
        expect(await desk.queued("sam")).toEqual([]);
      });

      it("gets the agent's reply in its chat thread on a team with a PM", async () => {
        desk = makeDesk(teamConfig(true));
        const r = await say("please add a search page");
        await scheduler.markActive(r.item.id);
        await scheduler.block(r.item.id, "stuck");
        const item = (await store.getItem(r.item.id))!;
        await desk.handedBack(item, { summary: "Need the staging key.", links: [] });
        expect(await desk.report("sam", item.id, "blocked")).toMatchObject({
          post: true,
          threads: [{ channel: "D1", thread: "m1" }],
        });
      });

      it("is reported by a blocked PM itself, as nobody else can route it", async () => {
        desk = makeDesk(teamConfig(true));
        const item = await scheduler.enqueue({
          person: "pat",
          kind: "assigned",
          title: "Assigned: ACME-4",
          trigger: "human",
          subject: { type: "ticket", ref: "ACME-4" },
        });

        await scheduler.markActive(item.id);
        await scheduler.block(item.id, "stuck");
        const blocked = (await store.getItem(item.id))!;
        await desk.handedBack(blocked, { summary: "stuck", links: [] });
        expect((await desk.report("pat", blocked.id, "blocked")).post).toBe(true);
      });
    });
  });

  describe("filing work", () => {
    it("creates a work item for the ticket in the session's thread, once", async () => {
      const { session, filed, item } = await fileWork("Add a search page", "ACME-5");
      expect(filed).toMatchObject({ url: tracker.links.issue("ACME-5"), waiting: false, work: [] });

      const created = (await store.getItem(item.id))!;
      expect(created).toMatchObject({
        kind: "assigned",
        parentId: session.id,
        subject: { type: "ticket", ref: "ACME-5" },
        status: "queued",
      });

      expect((await store.getItem(session.id))!.subject).toEqual({ type: "chat", ref: "D1:m1" });
      expect(await readOrigin(store, created.id)).toMatchObject({
        thread: "m1",
        requester: DANA,
        awaitingPlacement: false,
      });

      expect(await readOrigin(store, session.id)).toMatchObject({ filed: created.id });
      expect((await store.getSubject("chat_thread", "D1:m1"))?.data).toEqual({
        itemId: created.id,
      });

      // The same request again is refused, by the check before the ticket exists and by the filing itself.
      await expect(
        desk.checkFiling("sam", session.id, "  add A   search page "),
      ).rejects.toMatchObject({ code: "invalid" });

      await expect(
        desk.linkTicket("sam", session.id, "ACME-6", "Add a search page"),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("files each request of one message as its own work item", async () => {
      const first = await fileWork("Add a search page", "ACME-5");
      await desk.checkFiling("sam", first.session.id, "Fix the footer");
      const second = await desk.linkTicket("sam", first.session.id, "ACME-6", "Fix the footer");

      expect(second.item.id).not.toBe(first.item.id);
      expect(await store.getItem(second.item.id)).toMatchObject({
        parentId: first.session.id,
        subject: { type: "ticket", ref: "ACME-6" },
        status: "queued",
      });

      expect(await readOrigin(store, first.session.id)).toMatchObject({
        filed: second.item.id,
        requests: ["add a search page", "fix the footer"],
      });

      // The first filing does not make the person busy for the second: nothing is asked.
      expect(second.waiting).toBe(false);
      await expect(
        desk.linkTicket("sam", first.session.id, "ACME-7", "Fix the footer"),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("files work without a tracker as a request", async () => {
      const { filed } = await fileWork("Add a search page");
      expect(filed.url).toBeUndefined();
      expect(await store.getItem(filed.item.id)).toMatchObject({
        kind: "request",
        title: "Add a search page",
      });

      expect((await store.readJournal(filed.item.id)).map((j) => j.text).join("\n")).toContain(
        "Asked in chat.",
      );
    });

    it("is refused for other people's items and for items that are not chat sessions", async () => {
      const r = await say("Add a search page");
      await expect(desk.linkTicket("pat", r.item.id, "ACME-5", "x")).rejects.toMatchObject({
        code: "unknown_item",
      });

      const plain = await scheduler.enqueue({
        person: "sam",
        kind: "ticket",
        title: "x",
        trigger: "human",
      });

      await expect(desk.linkTicket("sam", plain.id, "ACME-5", "x")).rejects.toMatchObject({
        code: "invalid",
      });
    });

    it("lists the busy person's work and waits last, for the placement question", async () => {
      await busyWith("Running thing", "Queued thing");
      const { filed, item } = await fileWork();
      expect(filed.waiting).toBe(true);
      expect(filed.work.map((w) => [w.title, w.status])).toEqual([
        ["Running thing", "active"],
        ["Queued thing", "queued"],
      ]);

      expect(await queueOrder()).toEqual(["Queued thing", "Fix the footer"]);
      expect(await readOrigin(store, item.id)).toMatchObject({ awaitingPlacement: true });
    });

    it("starts at once for an idle person and asks nothing", async () => {
      const { item, filed } = await fileWork();
      expect(filed).toMatchObject({ waiting: false, work: [] });
      expect((await scheduler.next("sam"))?.id).toBe(item.id);
    });
  });

  describe("attaching a request to existing work", () => {
    const ticket = (key: string, extra: Partial<TicketRecord> = {}) => {
      const rec: TicketRecord = {
        key,
        title: "Search page",
        labels: [],
        status: "active",
        assignee: { id: "sam", kind: "agent" },
        updatedAt: "2030-01-01T00:00:00.000Z",
        ...extra,
      };

      tickets.push(rec);
      return rec;
    };

    const pull = (number: number, extra: Partial<PrRecord> = {}) => {
      const rec: PrRecord = {
        ref: { repo: { host: "git.acme.example", owner: "acme", name: "app" }, number },
        title: "feat: search page",
        url: `https://git.acme.example/acme/app/pull/${number}`,
        headRef: "search",
        headSha: "abc",
        baseRef: "main",
        draft: true,
        state: "open",
        mergeable: "clean",
        author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
        checks: [],
        ci: "success",
        unresolvedThreads: 0,
        ticket: "ACME-11",
        updatedAt: "2030-01-01T00:00:00.000Z",
        ...extra,
      };

      pulls.push(rec);
      return rec;
    };

    const session = async (text = "for the search PR, also support filters") => {
      const r = await say(text);
      await scheduler.markActive(r.item.id);
      return r.item;
    };

    const attach = async (target: string, confirmed = false, text?: string) => {
      const s = await session(text);
      return { s, attached: await desk.attachWork("sam", s.id, { target, confirmed }) };
    };

    it("joins the item that is working on an own ticket, carries the message, and moves the thread there", async () => {
      ticket("ACME-11");
      pull(11);
      const [running] = await busyWith("assigned: ACME-11 Search page");
      await store.updateItem(running!.id, { subject: { type: "ticket", ref: "ACME-11" } });

      const { s, attached } = await attach("ACME-11");
      expect(attached).toMatchObject({
        item: { id: running!.id },
        waiting: false,
        work: [],
        attached: { ticket: { ref: "ACME-11" }, pr: { ref: "#11" } },
      });

      // The active round is not interrupted and nothing is queued or asked.
      expect((await store.getItem(running!.id))!.status).toBe("active");
      expect((await store.listItems({ person: "sam", status: "queued" })).length).toBe(0);
      // The running round gets it after its hand-back, in a follow-up round, like any late feedback.
      expect(await readFeedback(store, running!.id)).toMatchObject([
        { kind: "chat", actor: "Dana", body: "for the search PR, also support filters" },
      ]);

      expect(await readOrigin(store, running!.id)).toMatchObject({
        thread: "m1",
        requester: DANA,
        awaitingPlacement: false,
      });

      expect(await readOrigin(store, s.id)).toMatchObject({ filed: running!.id });
      const journal = (await store.readJournal(running!.id)).map((j) => j.text).join("\n");
      expect(journal).toContain("In chat: for the search PR, also support filters");

      // A later reply in the thread gets a chat session about the running item, which keeps the thread.
      const reply = await say("and keep it fast", "m1");
      expect(reply.item.id).not.toBe(running!.id);
      expect((await readOrigin(store, reply.item.id))?.about).toMatchObject({
        id: running!.id,
        state: "running",
      });
    });

    it("keeps the item's own thread, adds the attached thread once, and has the result go to each", async () => {
      ticket("ACME-11");
      pull(11);
      const [running] = await busyWith("assigned: ACME-11 Search page");
      await store.updateItem(running!.id, { subject: { type: "ticket", ref: "ACME-11" } });
      // The item came from a thread of its own.
      await store.upsertSubject("chat_origin", running!.id, {
        channel: "D0",
        thread: "t0",
        requester: { id: "U0OTHER001" },
        awaitingPlacement: false,
        claimed: [],
      });

      await attach("ACME-11");
      await attach("ACME-11", false, "again, also support sorting");
      const origin = await readOrigin(store, running!.id);
      expect(origin).toMatchObject({
        channel: "D0",
        thread: "t0",
        requester: { id: "U0OTHER001" },
      });

      expect(origin?.also?.map((t) => t.thread)).toEqual(["m1", "m2"]);
      // The same thread attached again is not linked twice.
      expect(threadsOf(withThread(origin!, origin!.also![0]!))).toHaveLength(3);

      await scheduler.finish(running!.id, { outcome: "done", status: "done" });
      expect(await desk.report("sam", running!.id, "result")).toMatchObject({
        post: true,
        threads: [
          { channel: "D0", thread: "t0" },
          { channel: "D1", thread: "m1" },
          { channel: "D1", thread: "m2" },
        ],
      });
    });

    it("starts a round on an own draft pull request when nothing is working on it", async () => {
      ticket("ACME-11");
      pull(11);
      const { s, attached } = await attach("#11");
      const item = (await store.getItem(attached.item.id))!;
      expect(item).toMatchObject({
        kind: "review_feedback",
        status: "queued",
        trigger: "human",
        parentId: s.id,
        subject: { type: "pr", ref: "acme/app#11" },
      });

      expect(item.title).toContain("PR #11");
      expect(item.title).toContain("(ACME-11)");
      expect(await readFeedback(store, item.id)).toMatchObject([
        { actor: "Dana", kind: "chat", body: "for the search PR, also support filters" },
      ]);

      expect(await readOrigin(store, item.id)).toMatchObject({
        awaitingPlacement: false,
        thread: "m1",
      });

      expect(attached.attached.pr).toMatchObject({
        ref: "#11",
        url: "https://git.acme.example/acme/app/pull/11",
      });

      expect((await scheduler.next("sam"))?.id).toBe(item.id);
    });

    it("takes a pull request by number, link or ticket", async () => {
      ticket("ACME-11");
      pull(11);
      for (const target of [
        "11",
        "#11",
        "acme/app#11",
        "https://git.acme.example/acme/app/pull/11",
        "ACME-11",
      ]) {
        const s = await session();
        const done = await desk.attachWork("sam", s.id, { target, confirmed: false });
        expect(done.attached.pr?.ref).toBe("#11");
        await store.updateItem(done.item.id, { status: "canceled" });
      }
    });

    it("adds to an own ticket that has no pull request yet, as a round on the ticket", async () => {
      ticket("ACME-12", { title: "Billing" });
      const { attached } = await attach("ACME-12");
      expect(await store.getItem(attached.item.id)).toMatchObject({
        kind: "assigned",
        subject: { type: "ticket", ref: "ACME-12" },
      });

      expect(attached.attached).toMatchObject({ ticket: { ref: "ACME-12" } });
      expect(attached.attached.pr).toBeUndefined();
    });

    it("accepts a ticket the person last worked on, though a hand-back reassigned it", async () => {
      ticket("ACME-30", { assignee: { id: "dana", kind: "human" }, status: "blocked" });
      workers["ACME-30"] = "sam";
      const { attached } = await attach("ACME-30");
      expect(await store.getItem(attached.item.id)).toMatchObject({
        kind: "assigned",
        subject: { type: "ticket", ref: "ACME-30" },
      });
    });

    it("accepts a pull request the person authored whose ticket went to the requester", async () => {
      ticket("ACME-31", { assignee: { id: "dana", kind: "human" }, status: "review" });
      pull(31, { ticket: "ACME-31" });
      const { attached } = await attach("#31", true);
      expect(attached.attached.pr?.ref).toBe("#31");
    });

    it("refuses a ticket someone else worked on and holds", async () => {
      ticket("ACME-32", { assignee: { id: "dana", kind: "human" } });
      workers["ACME-32"] = "pat";
      await expect(
        desk.attachWork("sam", (await session()).id, { target: "ACME-32", confirmed: true }),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("refuses a ticket or pull request that is not the person's own", async () => {
      ticket("ACME-20", { assignee: { id: "pat", kind: "agent" } });
      ticket("ACME-21", { assignee: { id: "dana", kind: "human" } });
      pull(20, {
        ticket: "ACME-20",
        author: { login: "acme-pat[bot]", kind: "agent", person: "pat" },
      });

      for (const target of [
        "ACME-20",
        "ACME-21",
        "ACME-99",
        "20",
        "https://git.acme.example/acme/app/pull/20",
        "nonsense",
      ]) {
        const s = await session();
        await expect(
          desk.attachWork("sam", s.id, { target, confirmed: true }),
        ).rejects.toMatchObject({
          code: "invalid",
        });
      }

      expect((await store.listItems({ person: "sam" })).filter((i) => i.kind !== "chat")).toEqual(
        [],
      );
    });

    it("refuses a pull request in review until the requester confirmed, and queues nothing meanwhile", async () => {
      ticket("ACME-11", { status: "review" });
      pull(11, { draft: false, review: "approved" });
      const s = await session();
      const before = (await store.listItems({ person: "sam" })).length;
      await expect(
        desk.attachWork("sam", s.id, { target: "11", confirmed: false }),
      ).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("in review") as string,
      });

      expect((await store.listItems({ person: "sam" })).length).toBe(before);
      expect((await readOrigin(store, s.id))!.filed).toBeUndefined();

      const done = await desk.attachWork("sam", s.id, { target: "11", confirmed: true });
      expect(await store.getItem(done.item.id)).toMatchObject({
        kind: "review_feedback",
        subject: { type: "pr", ref: "acme/app#11" },
      });
    });

    it("treats a ticket in review without a pull request like a pull request in review", async () => {
      ticket("ACME-13", { status: "review" });
      const s = await session();
      await expect(
        desk.attachWork("sam", s.id, { target: "ACME-13", confirmed: false }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("in review") as string,
      });

      await expect(
        desk.attachWork("sam", s.id, { target: "ACME-13", confirmed: true }),
      ).resolves.toBeDefined();
    });

    it("still refuses a canceled ticket with an open pull request", async () => {
      ticket("ACME-16", { status: "canceled" });
      pull(16, { ticket: "ACME-16", draft: false });
      const s = await session();
      await expect(
        desk.attachWork("sam", s.id, { target: "16", confirmed: true }),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("never reopens merged or done work: it is a follow-up", async () => {
      ticket("ACME-14", { status: "done" });
      ticket("ACME-15");
      pull(15, { ticket: "ACME-15", state: "merged", draft: false });
      for (const target of ["ACME-14", "15"]) {
        const s = await session();
        await expect(
          desk.attachWork("sam", s.id, { target, confirmed: true }),
        ).rejects.toMatchObject({
          code: "invalid",
          message: expect.stringContaining("follow-up") as string,
        });
      }

      expect(await store.listItems({ person: "sam", status: "queued" })).toEqual([]);
    });

    it("attaches a request about an open pull request to its ticket even when the ticket was closed early", async () => {
      ticket("ACME-14", { status: "done" });
      pull(49, { ticket: "ACME-14", draft: false });
      for (const target of ["49", "ACME-14"]) {
        const { s, attached } = await attach(target, true, "fix the conflicts on PR #49");
        expect(attached).toMatchObject({
          attached: { ticket: { ref: "ACME-14" }, pr: { ref: "#49" } },
        });

        expect(await store.getItem(attached.item.id)).toMatchObject({
          kind: "review_feedback",
          subject: { type: "pr", ref: "acme/app#49" },
        });

        expect(await readOrigin(store, s.id)).toMatchObject({ filed: attached.item.id });
        await store.updateItem(attached.item.id, { status: "done" });
      }
    });

    it("attaches once per session and only from a chat session", async () => {
      ticket("ACME-11");
      const { s } = await attach("ACME-11");
      await expect(
        desk.attachWork("sam", s.id, { target: "ACME-11", confirmed: false }),
      ).rejects.toMatchObject({
        code: "invalid",
      });

      const plain = await scheduler.enqueue({
        person: "sam",
        kind: "ticket",
        title: "x",
        trigger: "human",
      });

      await expect(
        desk.attachWork("sam", plain.id, { target: "ACME-11", confirmed: false }),
      ).rejects.toMatchObject({
        code: "invalid",
      });

      await expect(
        desk.attachWork("pat", s.id, { target: "ACME-11", confirmed: false }),
      ).rejects.toMatchObject({
        code: "unknown_item",
      });
    });

    it("adds the message to the feedback a queued round already has", async () => {
      ticket("ACME-11");
      pull(11);
      const [queued] = await busyWith("review feedback: PR #11");
      await store.updateItem(queued!.id, {
        subject: { type: "pr", ref: "acme/app#11" },
        status: "queued",
      });

      await addFeedback(store, queued!.id, { actor: "grace", kind: "review", body: "Please fix" });

      const { attached } = await attach("11");
      expect(attached.item.id).toBe(queued!.id);
      expect((await readFeedback(store, queued!.id)).map((f) => [f.actor, f.kind])).toEqual([
        ["grace", "review"],
        ["Dana", "chat"],
      ]);

      expect((await store.readJournal(queued!.id)).map((j) => j.text).join("\n")).toContain(
        "for the search PR",
      );
    });
  });

  describe("report", () => {
    const finished = async (status: "done" | "blocked" = "done") => {
      const { item } = await fileWork("Add a search page", "ACME-1");
      await scheduler.markActive(item.id);
      if (status === "blocked") {
        await scheduler.block(item.id, "stuck");
      } else {
        await scheduler.finish(item.id, { outcome: "ok", status: "done" });
      }

      return item.id;
    };

    it("grants the result once per ending, with the ticket link", async () => {
      const id = await finished();
      const first = await desk.report("sam", id, "result");
      expect(first).toEqual({
        post: true,
        requester: DANA.id,
        links: [{ url: tracker.links.issue("ACME-1"), title: "ACME-1" }],
        threads: [
          { channel: "D1", thread: "m1", requester: DANA, direct: true, participant: true },
        ],
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
      desk = makeDesk(teamConfig(false));
      const id = await finished("blocked");
      expect((await desk.report("sam", id, "failed")).post).toBe(true);
      expect((await desk.report("sam", id, "failed")).post).toBe(false);
      expect((await desk.report("sam", id, "blocked")).post).toBe(true);
      expect((await desk.report("sam", id, "blocked")).post).toBe(false);
    });
  });

  describe("an item the scheduler blocked", () => {
    const stuck = async (over = teamConfig(false), chatThread = false) => {
      desk = makeDesk(over);
      const item = chatThread
        ? (await say("please add a search page")).item
        : await scheduler.enqueue({
            person: "sam",
            kind: "assigned",
            title: "Assigned: ACME-3",
            trigger: "human",
            subject: { type: "ticket", ref: "ACME-3" },
          });

      await scheduler.markActive(item.id);
      await scheduler.block(item.id, "failed 3 times: model overloaded\nstack");
      return (await store.getItem(item.id))!;
    };

    it("queues a report for the agent to post in a direct message, and pushes it", async () => {
      const pushed: string[] = [];
      desk = createChatDesk({
        clock,
        store,
        scheduler,
        team: teamConfig(false),
        workState: knownWork(),
        requesterChat: async () => DANA.id,
        linksOf: async () => [{ url: tracker.links.issue("ACME-3"), title: "ACME-3" }],
        notify: () => {},
        push: (p) => pushed.push(p),
      });

      const item = await scheduler.enqueue({
        person: "sam",
        kind: "assigned",
        title: "x",
        trigger: "human",
        subject: { type: "ticket", ref: "ACME-3" },
      });

      await scheduler.markActive(item.id);
      await scheduler.block(item.id, "failed 3 times: model overloaded\nstack");
      await desk.blocked(
        (await store.getItem(item.id))!,
        "failed 3 times: model overloaded\nstack",
      );

      expect(pushed).toEqual(["sam"]);
      expect(await desk.queued("sam")).toMatchObject([
        { kind: "blocked", text: "failed 3 times: model overloaded", direct: DANA.id },
      ]);
    });

    it("is left to the PM on a team with one: nothing is queued for a ticket without a chat thread", async () => {
      const item = await stuck(teamConfig(true));
      await desk.blocked(item, "stale twice");
      expect(await desk.queued("sam")).toEqual([]);
    });

    it("still tells the chat thread a human asked in, PM or not", async () => {
      const item = await stuck(teamConfig(true), true);
      await desk.blocked(item, "stale twice");
      expect(await desk.queued("sam")).toMatchObject([
        { kind: "blocked", threads: [{ channel: "D1", thread: "m1" }] },
      ]);
    });

    it("is dropped when the item is not blocked any more by the time the agent connects", async () => {
      const item = await stuck();
      await desk.blocked(item, "stale twice");
      await store.updateItem(item.id, { status: "queued" });
      expect(await desk.queued("sam")).toEqual([]);
    });
  });

  it("gives the person's current work as text", async () => {
    expect(await desk.currentWork("sam")).toContain("Ticket ACME-9");
  });
});

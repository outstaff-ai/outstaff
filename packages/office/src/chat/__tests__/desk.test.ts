import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeTracker } from "@outstaff/core/fakes";
import { beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../../clock.js";
import { createScheduler } from "../../scheduler/scheduler.js";
import { openStore } from "../../store/index.js";
import type { Store, WorkItem } from "../../store/types.js";
import { createChatDesk, type ChatRequests } from "../desk.js";
import { publicOrigin, readOrigin, threadsOf, withThread } from "../origin.js";
import type { PrRecord, TicketRecord } from "../../workstate/index.js";
import { addFeedback, readFeedback } from "../../engine/feedback.js";
import { parsePlacement } from "../placement.js";

function teamConfig(withPm = true, policies?: Record<string, unknown>): TeamConfig {
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
  let asked: { to: string; question: string; workItemId?: string | undefined }[];
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

  const say = (text: string, thread?: string, messageId = `m${++n}`) =>
    desk.message("sam", {
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
    asked = [];
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
      const r = await desk.message("sam", {
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

  it("keeps the files of a message on the chat origin, as metadata the agent gets with the offer", async () => {
    const files = [
      {
        id: "F1",
        name: "screen.png",
        mimetype: "image/png",
        size: 2048,
        url: "https://files.chat.acme.example/F1",
      },
    ];

    const r = await desk.message("sam", {
      messageId: "m-files",
      channel: "D1",
      text: "",
      author: DANA,
      direct: true,
      participant: true,
      files,
    });

    expect(r.disposition).toBe("started");
    const item = (await store.getItem(r.item.id))!;
    expect(item.title).toBe("Chat: screen.png");
    const origin = (await readOrigin(store, item.id))!;
    expect(origin.files).toEqual(files);
    expect(publicOrigin(origin).files).toEqual(files);
    expect((await store.readJournal(item.id))[0]!.text).toContain(
      "(Shared screen.png (image/png).)",
    );

    // A message without files leaves them out of what the agent sees, and a linked thread never carries them.
    const plain = (await readOrigin(store, (await say("no files")).item.id))!;
    expect(publicOrigin(plain)).not.toHaveProperty("files");
    expect(threadsOf(origin)[0]).not.toHaveProperty("files");
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

      // A later reply in the thread gets a chat session beside the running item, which keeps the thread.
      const reply = await say("and keep it fast", "m1");
      expect(reply).toMatchObject({ disposition: "started" });
      expect(reply.item.id).not.toBe(running!.id);
      expect((await store.readJournal(running!.id)).map((j) => j.text).join("\n")).toContain(
        "and keep it fast",
      );
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

    it("accepts a ticket the person last worked on, though a hand-back reassigned it, and assigns it back", async () => {
      ticket("ACME-30", { assignee: { id: "dana", kind: "human" }, status: "blocked" });
      workers["ACME-30"] = "sam";
      const { attached } = await attach("ACME-30");
      expect(await store.getItem(attached.item.id)).toMatchObject({
        kind: "assigned",
        subject: { type: "ticket", ref: "ACME-30" },
      });

      expect((await store.getSubject("attach_reassign", "sam:ACME-30"))?.data).toEqual({
        pending: true,
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

  it("starts a chat session beside the active item and queues nothing behind it", async () => {
    const [running] = await busyWith("Running thing", "Queued thing");
    const r = await say("would X be integrated in Y?");
    expect(r).toMatchObject({ disposition: "started", work: [] });
    expect(await readOrigin(store, r.item.id)).toMatchObject({ awaitingPlacement: false });

    // The office offers the session while the work item runs.
    expect((await scheduler.next("sam"))?.id).toBe(r.item.id);
    expect(await scheduler.markActive(r.item.id)).toMatchObject({ started: true });
    expect((await store.getItem(running!.id))!.status).toBe("active");
    expect(await tracker.listIssues({})).toEqual([]);
  });

  it("holds a message when all chat sessions are taken, and says so", async () => {
    await busyWith("Running thing");
    const first = await say("one");
    const second = await say("two");
    await scheduler.markActive(first.item.id);
    await scheduler.markActive(second.item.id);

    const third = await say("three");
    expect(third.disposition).toBe("limited");
    expect(await scheduler.next("sam")).toBeNull();

    await scheduler.finish(first.item.id, { outcome: "answered" });
    expect((await scheduler.next("sam"))?.id).toBe(third.item.id);
  });

  it.each([
    ["next", ["Fix the footer", "Queued A", "Queued B"], "next"],
    ["put it first please", ["Fix the footer", "Queued A", "Queued B"], "next"],
    ["last", ["Queued A", "Queued B", "Fix the footer"], "last"],
    ["after 2", ["Queued A", "Fix the footer", "Queued B"], "after Queued A"],
    ["after Queued B", ["Queued A", "Queued B", "Fix the footer"], "after Queued B"],
    ["after the current one", ["Fix the footer", "Queued A", "Queued B"], "next"],
  ])("places the waiting request when the requester says %j", async (answer, order, placement) => {
    await busyWith("Running thing", "Queued A", "Queued B");
    const { item } = await fileWork();
    expect(await queueOrder()).toEqual(["Queued A", "Queued B", "Fix the footer"]);
    notified.length = 0;

    const r = await say(answer, "m1");
    expect(r).toMatchObject({ disposition: "placed", placement });
    expect(await queueOrder()).toEqual(order);
    expect(await readOrigin(store, item.id)).toMatchObject({ awaitingPlacement: false });
    expect(notified).toEqual(["sam"]);
  });

  it("numbers the grouped list: a follow-up is not a place of its own, and 'after 1' goes behind the whole group", async () => {
    const add = (title: string, kind: string, ticket: string) =>
      scheduler.enqueue({
        person: "sam",
        kind,
        title,
        trigger: "human",
        subject: { type: "ticket", ref: ticket },
      });

    const running = await add("Checkout", "ticket", "ACME-5");
    await add("Search", "ticket", "ACME-6");
    await add("review feedback: Checkout", "review_feedback", "ACME-5");
    await scheduler.markActive(running.id);

    const { filed } = await fileWork();
    expect(filed.work).toHaveLength(3);
    notified.length = 0;

    const r = await say("after 1", "m1");
    expect(r).toMatchObject({ disposition: "placed", placement: "after Checkout" });
    expect(await queueOrder()).toEqual(["Search", "review feedback: Checkout", "Fix the footer"]);
  });

  it("asks the PM to prioritize when the requester wants that", async () => {
    await busyWith("Running thing", "Queued A");
    await fileWork();
    const r = await say("can you ask the PM to prioritize it?", "m1");
    expect(r.disposition).toBe("asked_pm");
    expect(asked[0]).toMatchObject({ to: "pm" });
    expect(asked[0]!.question).toContain("Queued A");
    expect(await queueOrder()).toEqual(["Queued A", "Fix the footer"]);
  });

  it("does not offer the PM when the team has none, and asks again when the answer is unclear", async () => {
    const noPm = createChatDesk({
      store,
      scheduler,
      team: teamConfig(false),
      workState: knownWork(),
      linksOf: async () => [],
      notify: () => {},
    });

    await busyWith("Running thing");
    const session = await noPm.message("sam", {
      messageId: "a",
      channel: "D1",
      text: "Hi",
      author: DANA,
      direct: true,
      participant: true,
    });

    await scheduler.markActive(session.item.id);
    await noPm.queueWork("sam", session.item.id, { title: "Hi", body: "" });
    const pm = await noPm.message("sam", {
      messageId: "b",
      channel: "D1",
      thread: "a",
      text: "ask the pm",
      author: DANA,
      direct: true,
      participant: true,
    });

    expect(pm.disposition).toBe("unclear");
    const vague = await noPm.message("sam", {
      messageId: "c",
      channel: "D1",
      thread: "a",
      text: "hmm let me think",
      author: DANA,
      direct: true,
      participant: true,
    });

    expect(vague.disposition).toBe("unclear");
    expect(vague.work).toHaveLength(1);
  });

  describe("a reply in the thread of running work", () => {
    const running = async () => {
      const { item } = await fileWork("Add a search page", "ACME-1");
      await scheduler.markActive(item.id);
      return item;
    };

    it("starts a chat session beside the work and journals the text", async () => {
      const item = await running();
      notified.length = 0;
      const r = await say("anything else on the design side?", "m1");
      expect(r.disposition).toBe("started");
      expect(r.item.id).not.toBe(item.id);
      expect(await store.getItem(r.item.id)).toMatchObject({ kind: "chat", status: "queued" });
      expect(notified).toEqual(["sam"]);

      const journal = (await store.readJournal(item.id)).map((j) => j.text).join("\n");
      expect(journal).toContain("In the chat thread: anything else on the design side?");
      expect(await readOrigin(store, r.item.id)).toMatchObject({
        thread: "m1",
        about: { id: item.id, title: item.title, state: "running" },
      });

      // The thread stays linked to the running item, so its result is posted there.
      expect((await store.getItem(item.id))!.status).toBe("active");
      const next = await say("and the cost?", "m1");
      expect((await readOrigin(store, next.item.id))?.about?.id).toBe(item.id);
    });

    it("says so when all chat sessions are taken", async () => {
      await running();
      expect((await say("one", "m1")).disposition).toBe("started");
      expect((await say("two", "m1")).disposition).toBe("limited");
    });
  });

  it("starts a chat session for a reply in a chat session's thread while it runs", async () => {
    const started = await say("Add a search page");
    await scheduler.markActive(started.item.id);
    const r = await say("also add a clear button", "m1");
    expect(r.disposition).toBe("started");
    const journal = (await store.readJournal(started.item.id)).map((j) => j.text).join("\n");
    expect(journal).toContain("also add a clear button");
    expect(await store.listItems({ person: "sam" })).toHaveLength(2);
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

  it("continues a finished chat session's thread in a new session with the same conversation", async () => {
    const started = await say("Is search planned?");
    await scheduler.markActive(started.item.id);
    await store.updateItem(started.item.id, { sessionId: "sess-1" });
    await scheduler.finish(started.item.id, { outcome: "yes", status: "done" });

    const r = await say("and dark mode?", "m1");
    expect(r.disposition).toBe("started");
    expect(r.item.id).not.toBe(started.item.id);
    const next = (await store.getItem(r.item.id))!;
    expect(next).toMatchObject({
      kind: "chat",
      parentId: started.item.id,
      sessionId: "sess-1",
      subject: { type: "chat", ref: "D1:m1" },
    });

    expect(await readOrigin(store, next.id)).toMatchObject({ thread: "m1" });
    // An answer has no work to continue.
    expect((await readOrigin(store, next.id))?.about).toBeUndefined();
  });

  it("answers a reply in the thread of finished filed work with a new chat session that knows the work", async () => {
    const { item } = await fileWork("Add a search page", "ACME-1");
    await scheduler.markActive(item.id);
    await scheduler.finish(item.id, { outcome: "done", status: "done" });

    const r = await say("one more thing: dark mode", "m1");
    expect(r.disposition).toBe("started");
    expect(await store.getItem(r.item.id)).toMatchObject({ kind: "chat", parentId: item.id });
    expect((await store.getItem(r.item.id))!.sessionId).toBeNull();
    expect((await readOrigin(store, r.item.id))?.about).toEqual({
      id: item.id,
      title: item.title,
      state: "finished",
    });
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

  describe("a reply in the thread of a blocked item", () => {
    const blocked = async () => {
      const { item } = await fileWork("Add a search page", "ACME-1");
      await scheduler.markActive(item.id);
      await store.updateItem(item.id, {
        sessionId: "s1",
        failures: 3,
        notBefore: "2999-01-01T00:00:00.000Z",
      });

      await store.recordLoopGuard(item.id);
      await scheduler.block(item.id, "stuck");
      notified.length = 0;
      return item.id;
    };

    it("retries it with a clean count and posts nothing itself", async () => {
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
      expect(notified).toEqual(["sam"]);
    });

    it("leaves it blocked when policies.retry.on_signal is off, and still keeps the reply", async () => {
      const id = await blocked();
      desk = makeDesk(teamConfig(true, { retry: { on_signal: false } }));
      await say("try again please", "m1");
      expect(await store.getItem(id)).toMatchObject({ status: "blocked" });
      expect((await store.readJournal(id)).map((j) => j.text)).toContain(
        "In the chat thread: try again please",
      );

      expect(notified).toEqual([]);
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
    });

    it("leaves a waiting item as it was", async () => {
      const r = await say("Add a search page");
      await store.updateItem(r.item.id, { status: "waiting" });
      await say("here is more", "m1");
      expect((await store.getItem(r.item.id))?.status).toBe("queued");
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
        false,
      );

      expect(pushed).toEqual(["sam"]);
      expect(await desk.queued("sam")).toMatchObject([
        { kind: "blocked", text: "failed 3 times: model overloaded", direct: DANA.id },
      ]);
    });

    it("is the PM's on a team with one: nothing is queued for a ticket without a chat thread", async () => {
      const item = await stuck(teamConfig(true));
      await desk.blocked(item, "stale twice", true);
      expect(await desk.queued("sam")).toEqual([]);
    });

    it("still tells the chat thread a human asked in, PM or not", async () => {
      const item = await stuck(teamConfig(true), true);
      await desk.blocked(item, "stale twice", true);
      expect(await desk.queued("sam")).toMatchObject([
        { kind: "blocked", threads: [{ channel: "D1", thread: "m1" }] },
      ]);
    });

    it("is dropped when the item is not blocked any more by the time the agent connects", async () => {
      const item = await stuck();
      await desk.blocked(item, "stale twice", false);
      await store.updateItem(item.id, { status: "queued" });
      expect(await desk.queued("sam")).toEqual([]);
    });
  });

  it("gives the person's current work as text", async () => {
    expect(await desk.currentWork("sam")).toContain("Ticket ACME-9");
  });
});

describe("parsePlacement", () => {
  const items = [
    { ids: ["w1", "w1b"], title: "Checkout bug", ticketKey: "ACME-4" },
    { ids: ["w2"], title: "Search page" },
  ];

  it.each([
    ["next", { type: "next" }],
    ["Last, no rush", { type: "last" }],
    ["after #2", { type: "after", itemIds: ["w2"] }],
    ["after acme-4", { type: "after", itemIds: ["w1", "w1b"] }],
    ["after w1b", { type: "after", itemIds: ["w1", "w1b"] }],
    ["after w2", { type: "after", itemIds: ["w2"] }],
    ["after the search page", { type: "after", itemIds: ["w2"] }],
    ["ask the PM please", { type: "pm" }],
    ["after 7", undefined],
    ["thanks", undefined],
  ])("reads %j", (text, expected) => {
    expect(parsePlacement(text, items)).toEqual(expected);
  });
});

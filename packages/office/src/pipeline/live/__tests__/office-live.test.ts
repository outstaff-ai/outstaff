import { createActMaker, createOfficeConnection, type OfficeConnection } from "@outstaff/agent";
import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  silentLogger,
  type Member,
  type PortName,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
  type FakeTracker,
} from "@outstaff/core/fakes";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createOffice } from "#/office.js";
import type { Office } from "#/office.types.js";
import { openStore, type Store } from "#/store/index.js";
import type { Trace } from "#/pipeline/trace.types.js";

const OFFICE_ACCOUNT: Member = { id: "u-1", name: "Office", kind: "agent" };

function team(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [
      { name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "u-ada", chat: "U-ada" } },
    ],
    repos: [{ name: "shop", url: "git.acme.example/acme-example/shop", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        model: "sonnet",
        identities: { tracker: "u-sam", vcs: "acme-sam[bot]" },
      },
      {
        handle: "pia",
        name: "Pia",
        role: "pm",
        model: "sonnet",
        identities: { tracker: "u-pia" },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    // These scenarios are about what a wake carries; coalescing has its own.
    pipeline: { wake: { coalesce_seconds: 0 }, notify: { debounce_seconds: 1 } },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

/** The fake tracker hands out ids in order; these are the members the team file names. */
async function seedMembers(tracker: FakeTracker) {
  const ada = await tracker.seed.member({ name: "Ada Admin", kind: "human" });
  const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
  const pia = await tracker.seed.member({ name: "Pia", kind: "agent" });
  return { ada, sam, pia };
}

describe("the office with the event pipeline live", () => {
  const clock = manualClock();
  let office: Office | undefined;
  let conn: OfficeConnection | undefined;
  let store: Store;

  afterEach(async () => {
    await conn?.stop();
    await office?.stop();
    conn = undefined;
    office = undefined;
  });

  async function start() {
    const vcs = createFakeVcs({ now: clock.now });
    const tracker = createFakeTracker({ now: clock.now, actor: OFFICE_ACCOUNT });
    const { ada, sam, pia } = await seedMembers(tracker);
    const config = team();
    config.humans![0]!.identities.tracker = ada.id;
    config.people[0]!.identities!.tracker = sam.id;
    config.people[1]!.identities!.tracker = pia.id;
    const chat = createFakeChat({ now: clock.now });
    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat } as Record<string, unknown>;
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: config,
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_SAM: "sam-token" }, "/nonexistent"),
      store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    await office.parts.intake.pollOnce();
    return { tracker, vcs, config, ada, sam, pia, registry };
  }

  /** Sam's agent process: its connection to the office, which makes sam's acts with sam's own tracker account. */
  function agent(
    tracker: FakeTracker,
    config: TeamConfig,
    sam: Member,
    chat = createFakeChat({ now: clock.now }),
  ) {
    const c = createOfficeConnection({
      url: `ws://127.0.0.1:${office!.agentPort()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
      clock,
    });

    const acts = createActMaker({
      env: { team: config, tracker: tracker.as(sam), chat },
      office: c,
      log: silentLogger,
    });

    c.onActs((list) => void acts.make(list));
    c.start();
    return c;
  }

  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await check()); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const traces = async () => (await store.listTraces({ limit: 200 })).map((t) => t.data as Trace);

  it("wakes the assignee, and has sam's own process make the hand-back's changes as sam", async () => {
    const { tracker, config, ada, sam } = await start();
    conn = agent(tracker, config, sam);
    await conn.whenConnected();

    // In backlog: a ready ticket created for sam would be pulled at once, before Ada's assignment is judged.
    const issue = await tracker.as(ada).createIssue({
      title: "Search",
      body: "",
      status: "backlog",
      assignee: sam.id,
    });

    await tracker.as(ada).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const offer = await conn.offers()[Symbol.asyncIterator]().next();
    const item = offer.value!.workItem;
    expect(item).toMatchObject({ kind: "assigned" });
    expect((await store.readJournal(item.id)).map((j) => j.text)).toContain(
      `${issue.key} is assigned to you. Work on it the way the repository asks.`,
    );

    // Accepting the item starts the work: sam's process makes the ticket active for it, and the office's state follows
    // from the act's answer.
    await conn.accept(item.id, { runtime: "claude", model: "sonnet" });
    await until(async () => office!.parts.workState.ticketStatus(issue.key) === "active");
    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("active");

    await conn.handBack(item.id, {
      summary: "Built it.",
      status: "done",
      toReview: ["opened pull request acme/app#1"],
    });

    const resultOf = async () => {
      const back = (await traces()).find((t) => t.event.type === "agent.handed_back");
      return back?.results?.[`${back.event.id}:hand_back_done`];
    };

    await until(async () => (await resultOf())?.status === "done");
    expect(await resultOf()).toMatchObject({
      status: "done",
      results: [`moved ${issue.key} to review`, `assigned ${issue.key} to ${ada.id}`],
    });

    const done = await tracker.getIssue(issue.key);
    expect(done.status.canonical).toBe("review");
    expect(done.assignee?.id).toBe(ada.id);
    const history = (await tracker.events()).events.filter((e) => e.key === issue.key);
    // Every change is sam's: the start of the work and the hand-back, with no note, since the history shows them.
    const moves = history.filter((e) => e.type === "moved");
    expect(moves.map((e) => [e.data["to"], e.actor.id])).toEqual([
      ["active", sam.id],
      ["review", sam.id],
    ]);

    expect(await tracker.listComments(issue.key)).toEqual([]);

    expect(history.some((e) => e.actor.id === OFFICE_ACCOUNT.id)).toBe(false);

    // The office read the ticket again from the answer: its state has the move before the tracker's feed says so.
    expect(office!.parts.workState.ticketStatus(issue.key)).toBe("review");

    const begun = (await traces()).find((t) => t.event.type === "agent.started")!;
    expect(begun.event).toMatchObject({
      id: expect.stringMatching(new RegExp(`^workstate:started:${item.id}:`)),
      subject: { ticket: issue.key },
      actor: { kind: "agent", id: "sam" },
      data: { workItem: item.id, kind: "assigned" },
    });

    expect(begun.results?.[`${begun.event.id}:start_marks_active`]).toMatchObject({
      status: "done",
      results: [`moved ${issue.key} to active`],
    });
  });

  it("hands in the tickets the item made with its own: in review, or with the pull request it opened", async () => {
    const { tracker, vcs, config, ada, sam } = await start();
    conn = agent(tracker, config, sam);
    await conn.whenConnected();
    const issue = await tracker.as(ada).createIssue({
      title: "Checkout",
      body: "",
      status: "backlog",
      assignee: sam.id,
    });

    await tracker.as(ada).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const item = (await conn.offers()[Symbol.asyncIterator]().next()).value!.workItem;
    await conn.accept(item.id, { runtime: "claude", model: "sonnet" });
    await until(async () => office!.parts.workState.ticketStatus(issue.key) === "active");

    // Sam splits the work: a part already in review, a part whose pull request it just opened, and one for later.
    const made = async (title: string, status: "review" | "active" | "backlog") => {
      const t = await tracker.as(sam).createIssue({ title, body: "", status, assignee: sam.id });
      await conn!.workMade({ workItemId: item.id, ticket: t.key });
      return t.key;
    };

    const review = await made("Cart half", "review");
    const opened = await made("Index half", "active");
    const later = await made("Later", "backlog");
    const repo = { host: "git.acme.example", owner: "acme-example", name: "shop" };
    const { number } = await vcs.seed.pullRequest(repo, {
      title: "Index half",
      body: `Closes ${opened}`,
      author: { login: "sam", kind: "agent" },
    });

    await conn.workMade({ workItemId: item.id, pr: { repo, number }, ticket: opened });
    expect(await store.listItemRefs(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ticket", ref: review, role: "created" }),
        expect.objectContaining({
          type: "pr",
          ref: `git.acme.example/acme-example/shop#${number}`,
        }),
      ]),
    );

    await conn.handBack(item.id, { summary: "Split in three.", status: "done" });
    const resultOf = async () => {
      const back = (await traces()).find((t) => t.event.type === "agent.handed_back");
      return back?.results?.[`${back.event.id}:hand_back_done`];
    };

    await until(async () => (await resultOf())?.status === "done");
    expect(await resultOf()).toMatchObject({
      results: [
        `moved ${issue.key} to review`,
        `assigned ${issue.key} to ${ada.id}`,
        `assigned ${review} to ${ada.id}`,
        `moved ${opened} to review`,
        `assigned ${opened} to ${ada.id}`,
      ],
    });

    for (const key of [issue.key, review, opened]) {
      expect(await tracker.getIssue(key)).toMatchObject({
        status: { canonical: "review" },
        assignee: { id: ada.id },
      });
    }

    expect((await tracker.getIssue(later)).status.canonical).toBe("backlog");
  });

  it("has sam tell the requester in a direct message, once no other notice came for a while", async () => {
    const { tracker, config, ada, sam } = await start();
    const chat = createFakeChat({ now: clock.now });
    conn = agent(tracker, config, sam, chat);
    await conn.whenConnected();
    const issue = await tracker.as(ada).createIssue({
      title: "Greeting",
      body: "",
      status: "backlog",
      assignee: sam.id,
    });

    await tracker.as(ada).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const offer = await conn.offers()[Symbol.asyncIterator]().next();
    const item = offer.value!.workItem;
    await conn.accept(item.id, { runtime: "claude", model: "sonnet" });
    await until(async () => office!.parts.workState.ticketStatus(issue.key) === "active");
    await conn.handBack(item.id, {
      summary: "Added the greeting.",
      status: "done",
      toReview: ["opened pull request acme/app#1"],
    });

    await until(async () => (await traces()).some((t) => t.event.type === "agent.handed_back"));
    expect(chat.posts).toEqual([]);

    clock.advance(1_100);
    await until(async () => chat.posts.length > 0);
    expect(chat.posts.map((p) => [p.channel, p.text])).toEqual([
      [
        await chat.openDirect("U-ada"),
        `Ready for your review: [${issue.key}](${tracker.links.issue(issue.key)}) Greeting\nAdded the greeting.`,
      ],
    ]);
  });

  it("queues the act of an offline agent and has it made once the agent connects", async () => {
    const { tracker, config, sam } = await start();
    const issue = await tracker.createIssue({ title: "Cart", body: "", status: "active" });
    await office!.parts.intake.pollOnce();
    await office!.parts.pipeline.judge({
      id: "office:handed_back:1",
      type: "agent.handed_back",
      at: clock.now().toISOString(),
      subject: { ticket: issue.key },
      actor: { kind: "agent", id: "sam" },
      data: { workItem: "w-1", kind: "assigned", status: "done" },
    });

    const recordOf = async () =>
      (await traces()).find((t) => t.event.id === "office:handed_back:1")?.results?.[
        "office:handed_back:1:hand_back_done"
      ];

    expect((await recordOf())?.status).toBe("queued");
    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("active");

    conn = agent(tracker, config, sam);
    await conn.whenConnected();
    await until(async () => (await recordOf())?.status === "done");
    expect(await recordOf()).toMatchObject({ status: "done" });
    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("review");
    const moves = (await tracker.events()).events.filter((e) => e.type === "moved");
    expect(moves.map((e) => e.actor.id)).toEqual([sam.id]);
  });

  it("wakes the PM once for a blocked hand-back: the echo of the assignment sam's process made wakes no one", async () => {
    const { tracker, config, ada, sam, pia } = await start();
    conn = agent(tracker, config, sam);
    await conn.whenConnected();
    const issue = await tracker.as(ada).createIssue({
      title: "Rotate the staging key",
      body: "",
      status: "backlog",
      assignee: sam.id,
    });

    await tracker.as(ada).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const offer = await conn.offers()[Symbol.asyncIterator]().next();
    const item = offer.value!.workItem;
    await conn.accept(item.id, { runtime: "claude", model: "sonnet" });
    await until(async () => office!.parts.workState.ticketStatus(issue.key) === "active");
    await conn.handBack(item.id, {
      summary: "The staging credentials are missing.",
      status: "blocked",
    });

    const resultOf = async () => {
      const back = (await traces()).find((t) => t.event.type === "agent.handed_back");
      return back?.results?.[`${back.event.id}:hand_back_blocked_to_pm`];
    };

    await until(async () => (await resultOf())?.status === "done");
    const blocked = await tracker.getIssue(issue.key);
    expect([blocked.status.canonical, blocked.assignee?.id]).toEqual(["blocked", pia.id]);

    // The tracker reports the act's changes as sam's: "assigned to pia by sam". They are the act's echo.
    await office!.parts.intake.pollOnce();
    const echo = (await traces()).find(
      (t) => t.event.type === "ticket.assigned" && t.event.actor.id === "sam",
    )!;

    const back = (await traces()).find((t) => t.event.type === "agent.handed_back")!;
    expect(echo.event.data["echo"]).toBe(`${back.event.id}:hand_back_blocked_to_pm`);
    expect(echo.aggregation).toMatchObject([
      {
        policy: "assigned_to_assignee",
        outcome: "rejected",
        reason: expect.stringMatching(/^the echo of act /),
      },
    ]);

    // Pia has one item for the hand-back: the unblock.
    const items = await store.listItems({ person: "pia" });
    expect(items.map((i) => i.kind)).toEqual(["unblock"]);

    // Pia's own assignment back to sam is not an echo: it wakes him.
    await tracker.as(pia).assign(issue.key, sam.id);
    await office!.parts.intake.pollOnce();
    const answer = (await traces()).find(
      (t) => t.event.type === "ticket.assigned" && t.event.actor.id === "pia",
    )!;

    expect(answer.event.data["echo"]).toBeUndefined();
    expect(answer.decisions).toMatchObject([
      { type: "wake", person: "sam", policy: "assigned_to_assignee" },
    ]);

    // The hand-off stays: pia was woken once in all, and the ticket is sam's.
    expect((await store.listItems({ person: "pia" })).map((i) => i.kind)).toEqual(["unblock"]);
    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe(sam.id);
  });

  it("wakes the PM once when the tracker reports the round's start only after the blocked hand-back", async () => {
    const { tracker, config, ada, sam, pia } = await start();
    conn = agent(tracker, config, sam);
    await conn.whenConnected();
    // Ada gives sam the ticket, then takes it back before he starts: his round's start takes it again.
    const issue = await tracker.as(ada).createIssue({
      title: "Rotate the staging key",
      body: "",
      status: "backlog",
      assignee: sam.id,
    });

    await office!.parts.intake.pollOnce();
    await tracker.as(ada).assign(issue.key, ada.id);
    await office!.parts.intake.pollOnce();
    const item = (await conn.offers()[Symbol.asyncIterator]().next()).value!.workItem;
    await conn.accept(item.id, { runtime: "claude", model: "sonnet" });
    await until(async () => office!.parts.workState.assignee(issue.key)?.id === "sam");

    // Sam is blocked at once. The tracker's feed has not been read since the round started.
    await conn.handBack(item.id, { summary: "The staging key is missing.", status: "blocked" });
    await until(async () => office!.parts.workState.assignee(issue.key)?.id === "pia");

    // Now it is: the start's assignment and move, then the hand-back's, each the echo of its own act.
    await office!.parts.intake.pollOnce();
    const echoes = (await traces())
      .filter((t) => t.event.actor.id === "sam" && t.event.type.startsWith("ticket."))
      .toSorted((a, b) => a.event.id.localeCompare(b.event.id, undefined, { numeric: true }))
      .map((t) => `${t.event.type} ${String(t.event.data["echo"]).split(":").at(-1)}`);

    expect(echoes).toEqual([
      "ticket.assigned start_marks_active",
      "ticket.moved start_marks_active",
      "ticket.moved hand_back_blocked_to_pm",
      "ticket.assigned hand_back_blocked_to_pm",
    ]);

    expect((await store.listItems({ person: "pia" })).map((i) => i.kind)).toEqual(["unblock"]);
    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe(pia.id);
  });

  it("bounds two agents that keep mentioning each other with the loop guard", async () => {
    const { tracker, ada, sam, pia } = await start();
    const issue = await tracker.as(ada).createIssue({
      title: "Fold into the device work",
      body: "",
      status: "backlog",
    });

    await office!.parts.intake.pollOnce();
    const scheduler = office!.parts.scheduler;
    const turns: string[] = [];
    for (let i = 0; i < 40; i++) {
      const [from, to] = i % 2 === 0 ? [sam, "pia"] : [pia, "sam"];
      await tracker.as(from).comment(issue.key, `@${to} over to you`);
      await office!.parts.intake.pollOnce();
      const queued = async () =>
        (await store.listItems({ person: to })).find((w) => w.status === "queued");

      await until(async () => (await queued()) !== undefined);
      const item = await queued();
      if (!item) {
        turns.push(`${to}: not woken`);
        break;
      }

      const started = await scheduler.markActive(item.id);
      if (!started.started) {
        turns.push(`${to}: ${started.reason}`);
        break;
      }

      turns.push(`${to}: ran`);
      await scheduler.finish(item.id, { outcome: "ok" });
      clock.advance(60_000);
    }

    // Each agent ran its 12 agent-triggered rounds on the ticket in the hour (the team's default limit), across one
    // work item per wake; the next wake is blocked until a human unblocks it.
    expect(turns.filter((t) => t === "pia: ran")).toHaveLength(12);
    expect(turns.filter((t) => t === "sam: ran")).toHaveLength(12);
    expect(turns.at(-1)).toBe("pia: loop_guard");
    const blocked = (await store.listItems({ person: "pia" })).find((w) => w.status === "blocked")!;
    expect((await store.readJournal(blocked.id)).at(-1)?.text).toMatch(/Blocked: Loop guard/);
  });

  it("bounds a pull request whose every new head fails with the loop guard", async () => {
    const { vcs } = await start();
    const repo = { host: "git.acme.example", owner: "acme-example", name: "shop" };
    const pr = await vcs.seed.pullRequest(repo, {
      author: { login: "acme-sam[bot]", kind: "agent" },
      title: "Add search",
    });

    await office!.parts.intake.pollOnce();
    const scheduler = office!.parts.scheduler;
    const turns: string[] = [];
    for (let i = 0; i < 20; i++) {
      // Each push fails before a rescan sees its checks pending: every head is a failure of its own.
      const pushed = await vcs.seed.push(repo, pr.number, "acme-sam[bot]");
      await vcs.seed.check(repo, pushed.head.sha, { name: "build", status: "failure" });
      await office!.parts.workState.rescan();
      const queued = async () =>
        (await store.listItems({ person: "sam" })).find((w) => w.status === "queued");

      await until(async () => (await queued()) !== undefined);
      const item = await queued();
      if (!item) {
        turns.push("not woken");
        break;
      }

      const started = await scheduler.markActive(item.id);
      if (!started.started) {
        turns.push(started.reason);
        break;
      }

      turns.push(item.kind);
      await scheduler.finish(item.id, { outcome: "ok" });
      clock.advance(60_000);
    }

    // One ci_failed round per failing head, on one pull request: the team's default limit of 12 in the hour holds.
    expect(turns.filter((t) => t === "ci_failed")).toHaveLength(12);
    expect(turns.at(-1)).toBe("loop_guard");
  });
});

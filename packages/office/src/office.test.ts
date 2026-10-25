import {
  createOfficeConnection,
  findVerb,
  runVerb,
  type AgentEnv,
  type OfficeConnection,
} from "@outstaff/agent";
import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  type PortName,
  type RepoRef,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
} from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "./clock.js";
import { createOffice, type Office } from "./office.js";
import { openStore, type Store } from "./store/index.js";

const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };
const SAM_LOGIN = "acme-sam[bot]";

function team(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "u-1", chat: "U-dana" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        identities: { vcs: SAM_LOGIN, tracker: "u-2" },
      },
      { handle: "mira", name: "Mira", role: "architect" },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    workflow: {
      rules: [
        {
          id: "tell-requester",
          on: "agent.handed_back",
          do: [{ notify: { to: "requester", template: "ready_for_review" } }],
        },
      ],
      templates: { ready_for_review: "{{ticket}} is ready for your review." },
    },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe("createOffice", () => {
  const clock = manualClock();
  let office: Office;
  let store: Store;
  let server: { port: number };
  let conns: OfficeConnection[];
  let vcs: ReturnType<typeof createFakeVcs>;
  let tracker: ReturnType<typeof createFakeTracker>;
  let chat: ReturnType<typeof createFakeChat>;

  const connect = (person: string) => {
    const c = createOfficeConnection({
      url: `ws://127.0.0.1:${server.port}/agent`,
      person,
      token: `${person}-token`,
      agentVersion: "test",
      clock,
    });

    c.start();
    conns.push(c);
    return c;
  };

  const next = async (c: OfficeConnection) => {
    const r = await c.offers()[Symbol.asyncIterator]().next();
    if (r.done) {
      throw new Error("no offer");
    }

    return r.value;
  };

  const envOf = (c: OfficeConnection, person: string) =>
    ({
      person,
      team: team(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      office: c,
    }) as unknown as AgentEnv;

  beforeEach(async () => {
    conns = [];
    vcs = createFakeVcs({ now: clock.now });
    tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-1", name: "Dana", kind: "human" },
    });

    chat = createFakeChat({ now: clock.now });
    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat } as Record<string, unknown>;
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    await tracker.seed.member({ name: "Sam", kind: "agent" });
    await vcs.seed.permission(REPO, "dana", "write");

    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: team(),
      registry,
      secrets: envSecretSource(
        { OUTSTAFF_AGENT_TOKEN_SAM: "sam-token", OUTSTAFF_AGENT_TOKEN_MIRA: "mira-token" },
        "/nonexistent",
      ),
      store,
      clock,
      catalog: {
        roles: { architect: { title: "Architect", summary: "Designs the system." } },
      },
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    // The first poll only sets the baseline; whatever a test seeds afterwards is new.
    await office.parts.intake.pollOnce();
    server = { port: office.agentPort() };
  });

  afterEach(async () => {
    await Promise.all(conns.map((c) => c.stop()));
    await office.stop();
  });

  it("turns a tracker assignment into work for a connected agent, and a hand-back into a move and a message", async () => {
    const sam = connect("sam");
    await sam.whenConnected();

    const issue = await tracker.createIssue({
      title: "Search page",
      body: "",
      status: "ready",
      assignee: "u-2",
    });

    await office.parts.intake.pollOnce();

    const offer = await next(sam);
    expect(offer.workItem).toMatchObject({ kind: "assigned", trigger: "human" });
    expect(offer.workItem.subject).toEqual({ type: "ticket", ref: issue.key });
    expect(offer.context.subjects[0]).toMatchObject({ type: "ticket", title: "Search page" });
    expect(offer.context.links[0]!.url).toContain(issue.key);

    await sam.accept(offer.workItem.id);
    await sam.handBack(offer.workItem.id, {
      summary: "Built the search page.",
      links: [{ url: "https://git.acme.example/acme/app/pull/1", title: "PR" }],
      status: "done",
    });

    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("review");
    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe("u-1");
    expect(chat.posts).toHaveLength(1);
    expect(chat.posts[0]!.channel).toBe("D-U-dana");
    expect(chat.posts[0]!.text).toBe(`${issue.key} is ready for your review.`);

    // A retried hand-back is harmless.
    await sam.handBack(offer.workItem.id, { summary: "again", status: "done" });
    expect(chat.posts).toHaveLength(1);
  });

  it("offers a conflicted stacked pull request to its author with the rebase recipe", async () => {
    const sam = connect("sam");
    await sam.whenConnected();

    const issue = await tracker.createIssue({ title: "Cart", body: "", status: "active" });
    const a = await vcs.seed.pullRequest(REPO, {
      title: "Base work",
      head: { ref: "feat/a" },
      author: { login: SAM_LOGIN, kind: "agent" },
    });

    const b = await vcs.seed.pullRequest(REPO, {
      title: "Cart on top",
      body: `Closes ${issue.key}`,
      head: { ref: "feat/b" },
      base: { ref: "feat/a" },
      author: { login: SAM_LOGIN, kind: "agent" },
      mergeable: ["clean", "conflicting"],
    });

    await office.parts.intake.pollOnce();
    expect(office.parts.workState.stackedOn(REPO, "feat/a").map((p) => p.ref.number)).toEqual([
      b.number,
    ]);

    await vcs.seed.merge(REPO, a.number, "dana");
    await office.parts.intake.pollOnce();

    const offer = await next(sam);
    expect(offer.workItem).toMatchObject({ kind: "conflict", trigger: "automation" });
    expect(offer.workItem.subject?.type).toBe("pr");
    const journal = offer.context.journal.map((j) => j.text).join("\n");
    expect(journal).toContain("git rebase origin/feat/a");
    expect(journal).toContain("--onto");
    expect(offer.context.subjects.map((s) => s.title)).toContain("Cart on top");
    expect(offer.context.subjects[0]).toMatchObject({
      type: "pr",
      headRef: "feat/b",
      baseRef: "feat/a",
      state: "open",
      own: true,
    });

    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe("u-2");
  });

  it("routes a question to the architect and brings the answer back to the asker", async () => {
    const sam = connect("sam");
    const mira = connect("mira");
    await Promise.all([sam.whenConnected(), mira.whenConnected()]);

    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Build the cart",
      trigger: "human",
    });

    const own = await next(sam);
    await sam.accept(own.workItem.id);
    const asked = await runVerb(
      findVerb("ask")!,
      envOf(sam, "sam"),
      { to: "architect", question: "Which queue should orders use?" },
      { workItemId: own.workItem.id },
    );

    expect(asked.text).toContain("Asked mira");
    await sam.handBack(own.workItem.id, {
      summary: "Waiting for the architect.",
      status: "waiting",
    });

    const question = await next(mira);
    expect(question.workItem).toMatchObject({ kind: "question", parentId: own.workItem.id });
    const text = question.context.journal.map((j) => j.text).join("\n");
    const id = /ost answer (\S+) "/.exec(text)![1]!;
    await mira.accept(question.workItem.id);
    await runVerb(
      findVerb("question.answer")!,
      envOf(mira, "mira"),
      { question: id, answer: "Use the fast queue." },
      { workItemId: question.workItem.id },
    );

    await mira.handBack(question.workItem.id, { summary: "Answered.", status: "done" });
    const resumed = await next(sam);
    expect(resumed.workItem.id).toBe(own.workItem.id);
    expect(resumed.context.journal.map((j) => j.text).join("\n")).toContain("Use the fast queue.");

    const roster = await runVerb(findVerb("team")!, envOf(sam, "sam"), {}, {});
    expect(roster.text).toContain("Architect");
    expect(roster.text).toContain("Dana");
  });

  it("reports health and stops cleanly", async () => {
    const health = await office.health();
    expect(health).toMatchObject({ ok: true, state: "running" });
    expect(Object.keys(health.components).toSorted()).toEqual([
      "intake",
      "protocol",
      "scheduler",
      "store",
      "workState",
    ]);

    await office.stop();
    await office.stop();
    expect(await office.health()).toMatchObject({ ok: false, state: "stopped" });
  });

  it("holds agent-triggered work above pause_automatic_at while a human chat request still runs", async () => {
    const sam = connect("sam");
    await sam.whenConnected();
    await sam.usage([{ name: "five_hour", utilization: 0.97, resetsAt: "2030-01-01T03:00:00Z" }]);

    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "review",
      title: "Review from a teammate",
      trigger: "agent",
    });

    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "chat",
      title: "Quick question from Dana",
      trigger: "human",
    });

    const offer = await next(sam);
    expect(offer.workItem).toMatchObject({ kind: "chat", trigger: "human" });
    await sam.accept(offer.workItem.id);
    await sam.handBack(offer.workItem.id, { summary: "Answered.", status: "done" });

    // The automatic item is still held, and says why.
    const held = (await store.listItems({ person: "sam", status: "queued" }))[0]!;
    expect(held.trigger).toBe("agent");
    expect(await office.parts.scheduler.isPausedFor("sam", held)).toMatchObject({
      code: "usage_pause",
    });

    const roster = await sam.team();
    expect(roster.members.find((m) => m.handle === "sam")?.usage).toEqual({
      window: "five_hour",
      utilization: 0.97,
      resetsAt: "2030-01-01T03:00:00Z",
    });

    expect(roster.members.find((m) => m.handle === "mira")?.usage).toBeUndefined();

    // Lower usage lets it through.
    await sam.usage([{ name: "five_hour", utilization: 0.2 }]);
    expect(await office.parts.scheduler.isPausedFor("sam", held)).toBeNull();
  });

  it("keeps whether an item was accepted across a reconnect", async () => {
    const sam = connect("sam");
    await sam.whenConnected();
    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Task",
      trigger: "human",
    });

    const offer = await next(sam);
    await sam.accept(offer.workItem.id);
    await sam.stop();

    const again = connect("sam");
    await again.whenConnected();
    expect(again.resume()).toEqual([offer.workItem.id]);
  });

  it("keeps the session of an item and offers it again after the agent drops the item", async () => {
    const sam = connect("sam");
    await sam.whenConnected();
    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Task",
      trigger: "human",
    });

    const offer = await next(sam);
    await sam.accept(offer.workItem.id);
    await sam.session(offer.workItem.id, "sess-1");
    const before = await office.parts.scheduler.next("sam");
    expect(before).toBeNull();
    const attempts = (await store.getItem(offer.workItem.id))!.attempts;
    await sam.decline(offer.workItem.id, "agent restarted");

    const again = await next(sam);
    expect(again.workItem.id).toBe(offer.workItem.id);
    expect(again.sessionId).toBe("sess-1");
    expect(again.context.journal.map((j) => j.text).join("\n")).toContain("agent restarted");
    expect((await store.getItem(offer.workItem.id))!.attempts).toBe(attempts);
  });
});

describe("createOffice configuration", () => {
  it("says which adapter is missing", async () => {
    await expect(
      createOffice({
        team: team(),
        registry: new AdapterRegistry(),
        secrets: envSecretSource({}, "/nonexistent"),
        store: await openStore("sqlite::memory:"),
        clock: manualClock(),
      }),
    ).rejects.toThrow('needs the vcs adapter "fake"');
  });
});

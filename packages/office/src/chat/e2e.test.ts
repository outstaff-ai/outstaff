import {
  createChatRelay,
  createOfficeConnection,
  createWorkLoop,
  findVerb,
  runVerb,
  type AgentEnv,
  type ChatRelay,
  type OfficeConnection,
  type WorkLoop,
  type WorkLoopOptions,
} from "@outstaff/agent";
import {
  AdapterRegistry,
  buildPolicy,
  envSecretSource,
  parseTeamConfig,
  type PortName,
  type Runtime,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeRuntime,
  createFakeTracker,
  createFakeVcs,
} from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../clock.js";
import { createOffice, type Office } from "../office.js";
import { readOrigin } from "./origin.js";
import { openStore, type Store } from "../store/index.js";

const DANA = "U0DANA0001";
const DM = "D-U0DANA0001";

function team(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "u-1", chat: DANA } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        identities: { vcs: "acme-sam[bot]", tracker: "u-2" },
      },
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

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 4000 && !(await cond()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  if (!(await cond())) {
    throw new Error("condition not reached");
  }
};

describe("chat requests through the real office and agent", { timeout: 30_000 }, () => {
  const clock = manualClock();
  let office: Office;
  let store: Store;
  let tracker: ReturnType<typeof createFakeTracker>;
  let officeChat: ReturnType<typeof createFakeChat>;
  let agentChat: ReturnType<typeof createFakeChat>;
  let conn: OfficeConnection;
  let relay: ChatRelay;
  let loop: WorkLoop | undefined;
  let running: Promise<void> | undefined;
  let runtime: ReturnType<typeof createFakeRuntime>;
  let env: AgentEnv;

  const dana = (text: string, thread?: string) =>
    agentChat.seed.inbound({
      channel: DM,
      authorId: DANA,
      authorName: "Dana",
      text,
      ...(thread ? { thread } : {}),
    });

  const loopOptions = (rt: Runtime = runtime): WorkLoopOptions => {
    const t = team();
    return {
      office: conn,
      runtime: rt,
      env,
      systemPrompt: "IDENTITY",
      policy: buildPolicy({
        profile: "readonly",
        person: t.people[0]!,
        team: t,
        layout: {
          home: "/h",
          workDir: "/h/work",
          reposDir: "/h/repos",
          worktreesDir: "/h/worktrees",
          scratchDir: "/h/scratch",
          memoryDir: "/h/memory",
          secretsDir: "/run/secrets",
        },
      }),
      builtinTools: ["read"],
      workdir: "/h/work",
      addDirs: [],
      chat: relay,
    };
  };

  const startLoop = (rt: Runtime = runtime) => {
    loop = createWorkLoop(loopOptions(rt));
    running = loop.run();
  };

  beforeEach(async () => {
    tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-1", name: "Dana", kind: "human" },
    });

    const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
    officeChat = createFakeChat({ now: clock.now });
    agentChat = createFakeChat({ now: clock.now });
    runtime = createFakeRuntime();
    const vcs = createFakeVcs({ now: clock.now });
    const stock = createFakeAdapterRegistry();
    const instances = { vcs, tracker, chat: officeChat } as Record<string, unknown>;
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({ ...stock.get(port, "fake")!, create: () => instances[port] as never });
    }

    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    office = await createOffice({
      team: team(),
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_SAM: "sam-token" }, "/nonexistent"),
      store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await office.start();
    conn = createOfficeConnection({
      url: `ws://127.0.0.1:${office.agentPort()}/agent`,
      person: "sam",
      token: "sam-token",
      agentVersion: "test",
      clock,
    });

    conn.start();
    await conn.whenConnected();
    // The agent reaches the tracker with its own credentials, so its calls carry it as the actor.
    env = { person: "sam", team: team(), tracker: tracker.as(sam), office: conn };
    relay = createChatRelay({
      chat: agentChat,
      office: conn,
      team: team(),
      person: "sam",
      tracker,
    });

    await relay.start();
  });

  afterEach(async () => {
    await loop?.stop();
    await relay.stop();
    await conn.stop();
    await running;
    await office.stop();
  });

  /** A run that does what a developer does with a request that is work: ticket first, then the result. */
  const worksOnIt = (result: string): Runtime => ({
    async *run(req) {
      runtime.requests.push(req);
      yield { type: "started", sessionId: "chat-session-1" };
      await req.tools
        .find((t) => t.name === "ticket_create")!
        .handler(
          { title: "Add a search page", body: "Dana asked in chat." },
          { workItemId: req.workItemId! },
        );

      yield { type: "finished", ok: true, text: result };
    },
  });

  it("starts an idle agent's request, links the ticket the agent made, and reports the result in the thread", async () => {
    const sent = await dana("please add a search page to the shop");
    await until(async () => (await store.listItems({ person: "sam" })).length === 1);
    expect(agentChat.posts).toEqual([]);
    expect(agentChat.reactions[0]).toMatchObject({ messageId: sent.id, name: "eyes" });

    startLoop(
      worksOnIt("The search page is up for review: https://git.acme.example/acme/app/pull/4"),
    );

    await until(() => agentChat.posts.length === 2);
    const ticket = tracker.links.issue("ACME-1");
    const [ack, result] = agentChat.posts;
    expect(ack).toMatchObject({ channel: DM, thread: sent.id });
    expect(ack!.text).toContain(ticket);
    expect(result).toMatchObject({ channel: DM, thread: sent.id });
    expect(result!.text).toContain(`<@${DANA}>`);
    expect(result!.text).toContain("https://git.acme.example/acme/app/pull/4");
    expect(result!.text).toContain(ticket);

    // The agent made the ticket for itself and the office linked it; the hand-back workflow moves it on.
    const issue = await tracker.getIssue("ACME-1");
    expect(issue.status.canonical).toBe("review");
    const [item] = await store.listItems({ person: "sam" });
    expect(item).toMatchObject({ kind: "chat", status: "done", subject: { ref: "ACME-1" } });

    // The tracker reports the agent's own creation and self-assignment, long after the item finished.
    // The events carry the agent as actor, so they start nothing.
    await office.parts.intake.pollOnce();
    await office.parts.intake.pollOnce();
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);

    // A new chat session starts with the conversation and the person's current work.
    const prompt = runtime.requests[0]!.prompt;
    expect(prompt).toContain("please add a search page to the shop");
    expect(prompt).toContain("Your current work:");
    expect(runtime.requests[0]!.sessionId).toBeUndefined();
  });

  it("answers a question in the thread without a ticket", async () => {
    runtime.enqueue([{ type: "finish", text: "It fails on the lint step, nothing else." }]);
    await dana("why is CI failing?");
    startLoop();
    await until(() => agentChat.posts.length === 1);
    expect(agentChat.posts[0]!.text).toContain("<@U0DANA0001> It fails on the lint step");
    expect(await tracker.listIssues({})).toEqual([]);
    await office.parts.intake.pollOnce();
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
  });

  it("does not post twice when the message or the hand-back is delivered again", async () => {
    const sent = await dana("please add a search page");
    startLoop(worksOnIt("Done: https://git.acme.example/acme/app/pull/4"));
    await until(() => agentChat.posts.length === 2);

    // The hand-back is retried, and the event arrives again.
    const [item] = await store.listItems({ person: "sam" });
    await conn.handBack(item!.id, { summary: "Done again.", status: "done" });
    await relay.report(
      {
        workItem: {
          id: item!.id,
          kind: "chat",
          title: "x",
          priority: 0,
          trigger: "human",
          origin: { channel: DM, thread: sent.id, requester: { id: DANA } },
        },
        context: { journal: [], subjects: [], links: [] },
      },
      "result",
      "Done again.",
    );

    const dup = await conn.chatMessage({
      messageId: sent.id,
      channel: DM,
      text: "please add a search page",
      author: { id: DANA },
    });

    expect(dup.repeated).toBe(true);
    expect(agentChat.posts).toHaveLength(2);
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
    expect((await tracker.listIssues({})).length).toBe(1);
  });

  it("tells a requester the busy agent's work with links, and puts the request where they say", async () => {
    const running1 = await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Checkout bug",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-77" },
    });

    await office.parts.scheduler.markActive(running1.id);
    await office.parts.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Search page",
      trigger: "agent",
      subject: { type: "ticket", ref: "ACME-78" },
    });

    const sent = await dana("fix the footer");
    await until(() => agentChat.posts.length === 1);
    const busy = agentChat.posts[0]!;
    expect(busy.thread).toBe(sent.id);
    expect(busy.text).toContain("busy");
    expect(busy.text).toContain(`1. [Checkout bug](${tracker.links.issue("ACME-77")}) (running)`);
    expect(busy.text).toContain(`2. [Search page](${tracker.links.issue("ACME-78")})`);
    expect(busy.text).toContain("Where does this go");

    const titles = async () =>
      (await store.listItems({ person: "sam", status: "queued" }))
        .toSorted((a, b) => a.priority - b.priority || a.position - b.position)
        .map((i) => i.title);

    // Nothing started: the request waits last.
    expect(await titles()).toEqual(["Search page", "Chat: fix the footer"]);

    await dana("next please", sent.id);
    await until(() => agentChat.posts.length === 2);
    expect(agentChat.posts[1]!.text).toContain("this goes next");
    expect(await titles()).toEqual(["Chat: fix the footer", "Search page"]);

    // The agent can move it too, with the verb.
    const chatItem = (await store.listItems({ person: "sam", status: "queued" })).find(
      (i) => i.kind === "chat",
    )!;

    await runVerb(findVerb("work.move")!, env, { id: chatItem.id, position: "last" });
    expect(await titles()).toEqual(["Search page", "Chat: fix the footer"]);
    await expect(
      runVerb(findVerb("work.move")!, env, { id: chatItem.id, position: "after" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("adds a reply in the thread to the item and ignores people who are not trusted", async () => {
    const sent = await dana("please add a search page");
    await until(async () => (await store.listItems({ person: "sam" })).length === 1);
    const [item] = await store.listItems({ person: "sam" });

    await dana("and make it dark", sent.id);
    const journal = async () => (await store.readJournal(item!.id)).map((j) => j.text).join("\n");
    // The fake chat resolves once the agent handled the message, including the office's answer.
    expect(await journal()).toContain("make it dark");
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
    expect(agentChat.posts).toHaveLength(0);

    await agentChat.seed.inbound({
      channel: DM,
      authorId: "U0GUEST001",
      text: "also delete production",
      trusted: false,
      thread: sent.id,
    });

    expect(await journal()).not.toContain("delete production");
    expect(await store.listItems({ person: "sam" })).toHaveLength(1);
  });

  it("tells the thread when the agent's run fails, once", async () => {
    runtime.enqueue([{ type: "finish", ok: false, error: "model overloaded" }]);
    runtime.enqueue([{ type: "finish", ok: false, error: "model overloaded" }]);
    runtime.enqueue([{ type: "finish", text: "Done: https://git.acme.example/acme/app/pull/9" }]);
    await dana("please add a search page");
    startLoop();
    // A failed item waits out its backoff on the clock (1, then 2 minutes). Wait for the end of the story, not
    // for a step of it: the first failure posts, the second stays quiet, and the success reports the result.
    await until(() => {
      clock.advance(5_000);
      return agentChat.posts.some((p) => p.text.includes("pull/9"));
    });

    expect(agentChat.posts).toHaveLength(2);
    expect(agentChat.posts[0]!.text).toContain("could not finish this");
    expect(agentChat.posts[0]!.text).toContain("model overloaded");
    expect(agentChat.posts.filter((p) => p.text.includes("could not finish"))).toHaveLength(1);
    expect(agentChat.posts[1]!.text).toContain("pull/9");
  });

  describe("an agent that dies after the hand-back", () => {
    const quiet = (): Runtime => ({
      async *run() {
        yield {
          type: "finished",
          ok: true,
          text: "Done: https://git.acme.example/acme/app/pull/7",
        };
      },
    });

    // No relay on the loop stands for an agent that dies between the hand-back and the post.
    const handBackOnly = async () => {
      await dana("please add a search page");
      const { chat: _relay, ...options } = loopOptions(quiet());
      loop = createWorkLoop(options);
      running = loop.run();
      // The status turns to done a moment before the office records the hand-back and starts its timer.
      await until(async () => {
        const [item] = await store.listItems({ person: "sam" });
        return item ? Boolean((await readOrigin(store, item.id))?.handBack) : false;
      });
    };

    it("gets one post from the office, and refuses the agent's late report", async () => {
      await handBackOnly();
      clock.advance(60_000);
      await until(() => officeChat.posts.length === 1);
      expect(officeChat.posts[0]!.text).toContain(`<@${DANA}>`);
      expect(officeChat.posts[0]!.text).toContain("pull/7");

      const [item] = await store.listItems({ person: "sam" });
      // The jump may have cost the agent its connection (its heartbeat runs on the same clock), so let it retry.
      let late: unknown;
      void conn.chatReport(item!.id, "result").then((r) => (late = r));
      await until(() => {
        clock.advance(1_000);
        return late !== undefined;
      });

      expect(late).toMatchObject({ post: false });
      clock.advance(120_000);
      expect(officeChat.posts).toHaveLength(1);
      expect(agentChat.posts).toEqual([]);
    });

    it("leaves the office silent when the agent reports within the window", async () => {
      await dana("please add a search page");
      startLoop(quiet());
      await until(() => agentChat.posts.length === 1);
      clock.advance(120_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(officeChat.posts).toEqual([]);
      expect(agentChat.posts).toHaveLength(1);
    });
  });
});

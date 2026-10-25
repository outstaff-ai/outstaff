import {
  buildPolicy,
  type Logger,
  type Policy,
  type RunRequest,
  type Runtime,
  type RuntimeEvent,
  type ToolKind,
  type TeamConfig,
  type Vcs,
} from "@outstaff/core";
import { createFakeRuntime, type FakeVcs } from "@outstaff/core/fakes";
import type { Message } from "@outstaff/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOfficeConnection,
  type Offer,
  type OfficeConnection,
} from "../office-client/index.js";
import { FakeSocket, createManualClock, type ManualClientClock } from "../office-client/testing.js";
import { fakeEnv } from "../verbs/testing.js";
import type { Workspaces } from "../repos/index.js";
import { JOURNAL_PROMPT } from "./journal.js";
import type { ChatRelay } from "./chat.js";
import { createWorkLoop, linksIn, type WorkLoop } from "./loop.js";
import { createUsageReporter, type UsageReporter } from "./usage.js";

/** An office that acknowledges everything and says a question is still open. */
class OfficeSocket extends FakeSocket {
  failJournal = false;

  override send(data: string) {
    super.send(data);
    const m = this.last();
    if (m.type === "hello") {
      return;
    }

    queueMicrotask(() => {
      if (m.type === "ask") {
        this.reply(m, "ask_result", { id: "q1", to: m.payload.to, status: "pending" });
      } else if (m.type === "journal" && this.failJournal) {
        this.reply(m, "error", { code: "invalid", message: "No journal today." });
      } else if (m.type === "work_list") {
        // The chat sessions of these tests are the items called c*.
        const id = m.payload.workItemId;
        this.reply(m, "work_list_result", {
          items: id?.startsWith("c")
            ? [{ id, title: "Chat", status: "active", kind: "chat", current: true }]
            : [],
        });
      } else if (m.type === "work_link" || m.type === "work_queue") {
        this.reply(m, m.type === "work_link" ? "work_link_result" : "work_queue_result", {
          item: { id: "w9", title: "Filed", status: "queued" },
          waiting: false,
          work: [],
        });
      } else {
        this.reply(m, "ack");
      }
    });
  }

  offerWith(
    id: string,
    extra: {
      sessionId?: string;
      journal?: boolean;
      origin?: boolean;
      kind?: string;
      feedback?: Record<string, unknown>[];
    } = {},
  ) {
    this.receive({
      id: `offer-${id}`,
      type: "offer",
      payload: {
        workItem: {
          id,
          kind: extra.kind ?? (extra.origin ? "chat" : "ticket"),
          ...(extra.feedback
            ? { subject: { type: "pr", ref: "git.acme.example/acme/app#1" } }
            : {}),
          title: `Fix ${id}`,
          priority: 1,
          trigger: "human",
          ...(extra.origin
            ? {
                origin: {
                  channel: "D1",
                  thread: "t1",
                  requester: { id: "U0REQ0001", name: "Dana" },
                },
              }
            : {}),
        },
        context: {
          journal: extra.journal
            ? [{ at: "2030-01-01T00:00:00Z", author: "sam", text: "Plan: a" }]
            : [],
          subjects: [
            {
              type: "ticket",
              ref: "SHOP-1",
              title: "Checkout",
              url: "https://t.acme.example/SHOP-1",
            },
          ],
          links: [],
          ...(extra.feedback ? { feedback: extra.feedback } : {}),
        },
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
      },
    });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) {
    await tick();
  }

  if (!cond()) {
    throw new Error("condition not reached");
  }
}

/** A runtime that runs until released or aborted, like a long session. */
function blockingRuntime() {
  const requests: RunRequest[] = [];
  let release: (() => void) | undefined;
  const runtime: Runtime = {
    async *run(req) {
      requests.push(req);
      yield { type: "started", sessionId: "sess-1" } satisfies RuntimeEvent;
      if (req.prompt === JOURNAL_PROMPT) {
        yield { type: "finished", ok: true, text: "" } satisfies RuntimeEvent;
        return;
      }

      yield { type: "text", text: "Working on it" } satisfies RuntimeEvent;
      await new Promise<void>((resolve) => {
        release = resolve;
        req.signal?.addEventListener("abort", () => resolve());
      });

      yield req.signal?.aborted
        ? { type: "finished", ok: false, text: "Working on it", interrupted: true }
        : { type: "finished", ok: true, text: "Done." };
    },
  };

  return { runtime, requests, release: () => release?.() };
}

describe("work loop", () => {
  let clock: ManualClientClock;
  let socket: OfficeSocket;
  let conn: OfficeConnection;
  let loop: WorkLoop;
  let running: Promise<void>;

  const sentOf = (type: string) => socket.sentOf(type) as Message[];
  const types = () => socket.sent.map((m) => m.type).filter((t) => t !== "hello");

  async function connect(resume: string[] = []) {
    conn = createOfficeConnection({
      url: "ws://office.test/agent",
      person: "sam",
      token: "t",
      agentVersion: "test",
      clock,
      socket: () => socket,
    });

    conn.start();
    socket.open();
    socket.welcome({ resume });
    await conn.whenConnected();
  }

  function start(
    runtime: Runtime,
    extra: {
      progressEveryMs?: number;
      workspaces?: Workspaces;
      usage?: UsageReporter;
      chat?: Pick<ChatRelay, "context" | "report" | "acknowledge">;
      vcs?: Vcs;
      log?: Logger;
      chatSession?: { policy: Policy; builtinTools: ToolKind[] };
      policies?: TeamConfig["policies"];
    } = {},
  ) {
    const { env, vcs } = fakeEnv();
    const { vcs: ownVcs, ...rest } = extra;
    const policy = buildPolicy({
      profile: "readonly",
      person: env.team.people[0]!,
      team: env.team,
      layout: {
        home: "/home/sam",
        workDir: "/home/sam/work",
        reposDir: "/home/sam/repos",
        worktreesDir: "/home/sam/worktrees",
        scratchDir: "/home/sam/scratch",
        memoryDir: "/home/sam/memory",
        secretsDir: "/run/secrets",
      },
    });

    loop = createWorkLoop({
      office: conn,
      runtime,
      env: { ...env, vcs: ownVcs ?? vcs, office: conn },
      systemPrompt: "IDENTITY",
      policy,
      builtinTools: ["read", "ost"],
      workdir: "/home/sam/work",
      addDirs: ["/home/sam/repos"],
      model: "sonnet",
      now: () => clock.now().getTime(),
      ...rest,
    });

    running = loop.run();
    return policy;
  }

  beforeEach(() => {
    clock = createManualClock();
    socket = new OfficeSocket();
  });

  it("accepts an offer, runs it and hands back with the summary and links", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([
      { type: "text", text: "Opened the pull request." },
      { type: "finish", text: "Fixed. See https://git.acme.example/shop/pull/7." },
    ]);

    const policy = start(runtime);
    socket.offerWith("w1", { journal: true });
    await until(() => sentOf("handback").length === 1);

    expect(types()).toEqual(["accept", "session", "progress", "journal", "handback"]);
    expect(sentOf("session")[0]?.payload).toEqual({
      workItemId: "w1",
      sessionId: "fake-session-1",
    });

    expect(sentOf("handback")[0]?.payload).toEqual({
      workItemId: "w1",
      summary: "Fixed. See https://git.acme.example/shop/pull/7.",
      links: [{ url: "https://git.acme.example/shop/pull/7" }],
      status: "done",
    });

    const req = runtime.requests[0]!;
    expect(req.sessionId).toBeUndefined();
    expect(req.workItemId).toBe("w1");
    expect(req.systemPrompt).toBe("IDENTITY");
    expect(req.policy).toBe(policy);
    expect(req.workdir).toBe("/home/sam/work");
    expect(req.builtinTools).toEqual(["read", "ost"]);
    expect(req.model).toBe("sonnet");
    expect(req.prompt).toContain("Work item w1 (ticket): Fix w1");
    expect(req.prompt).toContain("ticket SHOP-1 Checkout (https://t.acme.example/SHOP-1)");
    expect(req.prompt).toContain("sam: Plan: a");

    await loop.stop();
    await conn.stop();
    await running;
  });

  it("forwards runtime usage events to the office, throttled, and the held one when the item ends", async () => {
    await connect();
    const runtime = createFakeRuntime();
    const w = (utilization: number) => ({
      name: "five_hour",
      utilization,
      resetsAt: "2030-01-01T05:00:00Z",
    });

    runtime.enqueue([
      { type: "usage", windows: [w(0.1)] },
      { type: "usage", windows: [w(0.2)] },
      { type: "usage", windows: [w(0.3)] },
      { type: "usage", windows: [w(0.9)] },
      { type: "usage", windows: [w(0.92)] },
      { type: "finish", text: "Done." },
    ]);

    const reporter = createUsageReporter({
      send: (windows) => conn.usage(windows),
      clock,
    });

    start(runtime, { usage: reporter });
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);

    // 0.1 goes out; 0.2 and 0.3 are held; 0.9 crosses the defer threshold and goes at once; 0.92 is held and
    // sent when the item ends.
    expect(
      sentOf("usage").map(
        (m) => (m.payload as { windows: { utilization: number }[] }).windows[0]!.utilization,
      ),
    ).toEqual([0.1, 0.9, 0.92]);

    await loop.stop();
    await conn.stop();
    await running;
  });

  it("works in the item's worktree and removes it only when the item is done", async () => {
    await connect();
    const released: string[] = [];
    const workspaces: Workspaces = {
      async prepare(o) {
        return {
          repo: "shop",
          worktree: `/home/sam/worktrees/shop/${o.workItem.id}`,
          branch: `ticket/${o.workItem.id}`,
          scratch: `/home/sam/scratch/${o.workItem.id}`,
        };
      },
      async release(id) {
        released.push(id);
      },
    };

    const asks: Runtime = {
      async *run(req) {
        if (req.workItemId === "w2") {
          await req.tools
            .find((t) => t.name === "ask")!
            .handler({ to: "mira", question: "Which queue?" }, { workItemId: "w2" });
        }

        yield { type: "finished", ok: true, text: "ok" };
      },
    };

    const requests: RunRequest[] = [];
    const runtime: Runtime = {
      run(req) {
        requests.push(req);
        return asks.run(req);
      },
    };

    start(runtime, { workspaces });
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);
    socket.offerWith("w2");
    await until(() => sentOf("handback").length === 2);

    expect(requests[0]?.workdir).toBe("/home/sam/work");
    expect(requests[0]?.addDirs).toEqual([
      "/home/sam/repos",
      "/home/sam/worktrees/shop/w1",
      "/home/sam/scratch/w1",
    ]);

    expect(requests[0]?.prompt).toContain(
      "worktree for this item is /home/sam/worktrees/shop/w1 (repository shop, branch ticket/w1)",
    );

    expect(sentOf("handback").map((m) => (m.payload as { status: string }).status)).toEqual([
      "done",
      "waiting",
    ]);

    // w2 is waiting for an answer, so its worktree stays for the next round.
    expect(released).toEqual(["w1"]);
    await loop.stop();
    await conn.stop();
  });

  it("appends a journal entry from the same session before every hand-back", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", text: "Fixed. https://git.acme.example/shop/pull/7" }]);
    runtime.enqueue([
      {
        type: "finish",
        text: "Done: fixed it\nDecisions: kept the old API\nOpen: none\nLinks: https://git.acme.example/shop/pull/7",
      },
    ]);

    start(runtime);
    socket.offerWith("w1", { sessionId: "stored-1" });
    await until(() => sentOf("handback").length === 1);

    const order = types();
    expect(order.indexOf("journal")).toBeLessThan(order.indexOf("handback"));
    expect(sentOf("journal")[0]?.payload).toEqual({
      workItemId: "w1",
      text: "Done: fixed it\nDecisions: kept the old API\nOpen: none\nLinks: https://git.acme.example/shop/pull/7",
    });

    const [, ask] = runtime.requests;
    expect(ask?.prompt).toBe(JOURNAL_PROMPT);
    expect(ask?.sessionId).toBe("stored-1");
    expect(ask?.tools).toEqual([]);
    expect(ask?.builtinTools).toEqual([]);
    await loop.stop();
    await conn.stop();
  });

  it("falls back to the final message when the journal answer is not in the format", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", text: "Fixed. https://git.acme.example/shop/pull/7" }]);
    runtime.enqueue([{ type: "finish", text: "Sure, I did a lot." }]);
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);

    const text = (sentOf("journal")[0]!.payload as { text: string }).text;
    expect(text).toContain("Done: Fixed. https://git.acme.example/shop/pull/7");
    expect(text).toContain("Links: https://git.acme.example/shop/pull/7");
    await loop.stop();
    await conn.stop();
  });

  it("still hands back when the journal cannot be stored", async () => {
    await connect();
    socket.failJournal = true;
    start(createFakeRuntime());
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);
    expect(sentOf("journal")).toHaveLength(1);
    expect(sentOf("fail")).toHaveLength(0);
    await loop.stop();
    await conn.stop();
  });

  it("starts a new session from the journal when the stored one is lost, and says so", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([
      { type: "finish", ok: false, error: "No conversation found", sessionLost: true },
    ]);

    runtime.enqueue([{ type: "finish", text: "Carried on from the journal." }]);
    start(runtime);
    socket.offerWith("w1", { sessionId: "gone-1", journal: true });
    await until(() => sentOf("handback").length === 1);

    const [lost, fresh] = runtime.requests;
    expect(lost?.sessionId).toBe("gone-1");
    expect(fresh?.sessionId).toBeUndefined();
    expect(fresh?.prompt).toContain("could not be resumed");
    expect(fresh?.prompt).toContain("sam: Plan: a");
    expect(fresh?.prompt).toContain("ticket SHOP-1 Checkout");

    const journals = sentOf("journal").map((m) => (m.payload as { text: string }).text);
    expect(journals[0]).toContain("Session restarted from journal");
    expect(sentOf("fail")).toHaveLength(0);
    expect(sentOf("handback")[0]?.payload).toMatchObject({
      summary: "Carried on from the journal.",
      status: "done",
    });

    // The new session replaces the lost one in the office.
    expect(sentOf("session")[0]?.payload).toEqual({
      workItemId: "w1",
      sessionId: "fake-session-1",
    });

    await loop.stop();
    await conn.stop();
  });

  it("fails the item, not restarts, when a fresh run reports a lost session", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", ok: false, error: "boom", sessionLost: true }]);
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("fail").length === 1);
    expect(runtime.requests).toHaveLength(1);
    await loop.stop();
    await conn.stop();
  });

  it("exposes the verbs as tools, including ask and answer", async () => {
    await connect();
    const runtime = createFakeRuntime();
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);

    const names = runtime.requests[0]!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask", "question_answer", "ticket_show", "me"]));
    await loop.stop();
    await conn.stop();
  });

  it("resumes the stored session and does not store it again", async () => {
    await connect();
    const runtime = createFakeRuntime();
    start(runtime);
    socket.offerWith("w1", { sessionId: "stored-1" });
    await until(() => sentOf("handback").length === 1);

    expect(runtime.requests[0]?.sessionId).toBe("stored-1");
    expect(runtime.requests[0]?.prompt).toContain("continues your earlier session");
    expect(sentOf("session")).toHaveLength(0);
    await loop.stop();
    await conn.stop();
  });

  it("keeps heartbeats going with the item while the runtime works", async () => {
    await connect();
    const { runtime, release } = blockingRuntime();
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("progress").length === 1);

    clock.advance(1000);
    await tick();
    expect(sentOf("heartbeat").at(-1)?.payload).toEqual({ workItemId: "w1" });
    release();
    await until(() => sentOf("handback").length === 1);
    await loop.stop();
    await conn.stop();
  });

  it("throttles progress from text events", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "text", text: "three" },
    ]);

    start(runtime, { progressEveryMs: 60_000 });
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);
    expect(sentOf("progress").map((m) => (m.payload as { text: string }).text)).toEqual(["one"]);
    await loop.stop();
    await conn.stop();
  });

  it("fails the item with the reason when the run fails", async () => {
    await connect();
    const runtime = createFakeRuntime();
    runtime.enqueue([{ type: "finish", ok: false, error: "rate limited" }]);
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("fail").length === 1);

    expect(sentOf("fail")[0]?.payload).toEqual({ workItemId: "w1", reason: "rate limited" });
    expect(sentOf("handback")).toHaveLength(0);
    await loop.stop();
    await conn.stop();
  });

  it("fails the item when the runtime throws, and carries on with the next offer", async () => {
    await connect();
    let calls = 0;
    const runtime: Runtime = {
      // eslint-disable-next-line require-yield
      async *run() {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }

        yield { type: "finished", ok: true, text: "fine" };
      },
    };

    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("fail").length === 1);
    socket.offerWith("w2");
    await until(() => sentOf("handback").length === 1);
    expect(sentOf("fail")[0]?.payload).toEqual({ workItemId: "w1", reason: "boom" });
    expect(sentOf("handback")[0]?.payload).toMatchObject({ workItemId: "w2" });
    await loop.stop();
    await conn.stop();
  });

  it("interrupts the runtime on stop and hands the item back as waiting", async () => {
    await connect();
    const { runtime, requests } = blockingRuntime();
    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("progress").length === 1);

    await loop.stop();
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(sentOf("handback")[0]?.payload).toMatchObject({
      workItemId: "w1",
      status: "waiting",
      summary: expect.stringContaining("Last message: Working on it"),
    });

    expect(sentOf("fail")).toHaveLength(0);
    await conn.stop();
    await running;
  });

  it("hands back as waiting when the agent asked a question that is still open", async () => {
    await connect();
    const runtime: Runtime = {
      async *run(req) {
        yield { type: "started", sessionId: "s" };
        const ask = req.tools.find((t) => t.name === "ask")!;
        await ask.handler(
          { to: "mira", question: "Which queue?" },
          { workItemId: req.workItemId! },
        );

        yield { type: "finished", ok: true, text: "Asked Mira; waiting for the answer." };
      },
    };

    start(runtime);
    socket.offerWith("w1");
    await until(() => sentOf("handback").length === 1);
    expect(sentOf("ask")[0]?.payload).toMatchObject({ to: "mira", workItemId: "w1" });
    expect(sentOf("handback")[0]?.payload).toMatchObject({ status: "waiting" });
    await loop.stop();
    await conn.stop();
  });

  it("works one item at a time", async () => {
    await connect();
    const { runtime, release } = blockingRuntime();
    start(runtime);
    socket.offerWith("w1");
    socket.offerWith("w2");
    await until(() => sentOf("progress").length === 1);
    expect(sentOf("accept").map((m) => (m.payload as { workItemId: string }).workItemId)).toEqual([
      "w1",
    ]);

    release();
    await until(() => sentOf("accept").length === 2);
    release();
    await until(() => sentOf("handback").length === 2);
    await loop.stop();
    await conn.stop();
  });

  const relay = () => {
    const reports: { kind: string; text: string; links: unknown; item: string }[] = [];
    const acks: { item: string; key: string }[] = [];
    const chat: Pick<ChatRelay, "context" | "report" | "acknowledge"> = {
      async context() {
        return "Recent messages:\n- Dana: add search\n\nYour current work:\nTicket ACME-9";
      },
      async acknowledge(offer, what) {
        acks.push({ item: offer.workItem.id, key: what.key ?? what.title });
      },
      async report(offer, kind, text, links) {
        reports.push({ kind, text, links, item: offer.workItem.id });
      },
    };

    return { chat, reports, acks };
  };

  describe("chat sessions beside a work item", () => {
    const layout = {
      home: "/home/sam",
      workDir: "/home/sam/work",
      reposDir: "/home/sam/repos",
      worktreesDir: "/home/sam/worktrees",
      scratchDir: "/home/sam/scratch",
      memoryDir: "/home/sam/memory",
      secretsDir: "/run/secrets",
    };

    const sessionFor = () => {
      const { env } = fakeEnv();
      const policy = buildPolicy({
        profile: "chat",
        person: env.team.people[0]!,
        team: env.team,
        layout,
      });

      return { policy, builtinTools: ["read", "search", "shell", "ost"] as ToolKind[] };
    };

    it("runs a chat session while the work item runs, under the chat policy and without a worktree", async () => {
      await connect();
      const requests: RunRequest[] = [];
      let releaseWork: (() => void) | undefined;
      const runtime: Runtime = {
        async *run(req) {
          requests.push(req);
          yield { type: "started", sessionId: `s-${req.workItemId}` };
          if (req.prompt === JOURNAL_PROMPT) {
            yield { type: "finished", ok: true, text: "" };
            return;
          }

          if (req.workItemId === "w1") {
            await new Promise<void>((resolve) => {
              releaseWork = resolve;
            });
          }

          yield { type: "finished", ok: true, text: "Answered." };
        },
      };

      const prepared: string[] = [];
      const workspaces = {
        async prepare(offer: Offer) {
          prepared.push(offer.workItem.id);
          return undefined;
        },
        async release() {},
      } as unknown as Workspaces;

      const { chat, reports } = relay();
      start(runtime, { chat, workspaces, chatSession: sessionFor() });
      socket.offerWith("w1");
      await until(() => requests.some((r) => r.workItemId === "w1"));

      // The work item is still running when the chat message arrives.
      socket.offerWith("c1", { origin: true });
      await until(() => reports.length === 1);
      expect(reports[0]).toMatchObject({ kind: "result", item: "c1", text: "Answered." });
      expect(
        sentOf("handback").map((m) => (m.payload as { workItemId: string }).workItemId),
      ).toEqual(["c1"]);

      const chatRun = requests.find((r) => r.workItemId === "c1")!;
      const workRun = requests.find((r) => r.workItemId === "w1")!;
      expect(chatRun.policy.profile).toBe("chat");
      expect(workRun.policy.profile).toBe("readonly");
      expect(prepared).toEqual(["w1"]);
      expect(chatRun.tools.map((t) => t.name)).toContain("ticket_create");
      expect(chatRun.tools.map((t) => t.name)).toContain("work_queue");
      expect(chatRun.tools.map((t) => t.name)).not.toContain("pr_open");
      expect(chatRun.tools.map((t) => t.name)).not.toContain("work_move");
      expect(workRun.tools.map((t) => t.name)).toContain("pr_open");

      releaseWork?.();
      await until(() => sentOf("handback").length === 2);
      await loop.stop();
      await conn.stop();
    });

    it("keeps every running item alive and stops them all on shutdown", async () => {
      await connect();
      const { runtime } = blockingRuntime();
      start(runtime, { chatSession: sessionFor() });
      socket.offerWith("w1");
      socket.offerWith("c1", { origin: true });
      await until(() => sentOf("accept").length === 2);
      await until(() => sentOf("progress").length === 2);
      await loop.stop();
      await conn.stop();
      await running;
      expect(sentOf("handback")).toHaveLength(2);
    });
  });

  describe("chat requests", () => {
    it("acknowledges in the thread when a chat session files its request, and reports no result of its own", async () => {
      await connect();
      const { chat, acks, reports } = relay();
      const runtime: Runtime = {
        async *run(req) {
          yield { type: "started", sessionId: "s" };
          await req.tools
            .find((t) => t.name === "ticket_create")!
            .handler({ title: "Add search" }, { workItemId: req.workItemId! });

          yield { type: "finished", ok: true, text: "Done." };
        },
      };

      start(runtime, { chat });
      socket.offerWith("c1", { origin: true });
      await until(() => sentOf("handback").length === 1);
      expect(sentOf("work_link")[0]?.payload).toMatchObject({ workItemId: "c1" });
      expect(acks).toEqual([{ item: "c1", key: expect.stringMatching(/^SHOP-/) as string }]);
      expect(reports).toEqual([]);
      await loop.stop();
      await conn.stop();
    });

    it("starts a new chat session with the conversation and current work, and reports the result", async () => {
      await connect();
      const { chat, reports } = relay();
      const runtime = createFakeRuntime();
      runtime.enqueue([{ type: "finish", text: "Search is up: https://git.acme.example/pull/3" }]);
      start(runtime, { chat });
      socket.offerWith("c1", { origin: true });
      await until(() => reports.length === 1);

      const prompt = runtime.requests[0]!.prompt;
      expect(prompt).toContain("message from Dana, a trusted human, in chat");
      expect(prompt).toContain("Recent messages:\n- Dana: add search");
      expect(prompt).toContain("Ticket ACME-9");
      expect(reports).toEqual([
        {
          kind: "result",
          item: "c1",
          text: "Search is up: https://git.acme.example/pull/3",
          links: [{ url: "https://git.acme.example/pull/3" }],
        },
      ]);

      // Reported after the hand-back, so the office sees the item done when it grants the report.
      expect(types().indexOf("handback")).toBeGreaterThan(-1);
      await loop.stop();
      await conn.stop();
    });

    it("restarts a lost chat session with the conversation, the journal entry, and reports once after it", async () => {
      await connect();
      const { chat, reports } = relay();
      const runtime = createFakeRuntime();
      runtime.enqueue([
        { type: "finish", ok: false, error: "No conversation found", sessionLost: true },
      ]);

      runtime.enqueue([{ type: "finish", text: "Done: https://git.acme.example/pull/5" }]);
      start(runtime, { chat });
      socket.offerWith("c1", { origin: true, sessionId: "gone-1" });
      await until(() => reports.length === 1);

      const [lost, fresh] = runtime.requests;
      expect(lost?.sessionId).toBe("gone-1");
      expect(lost?.prompt).not.toContain("Recent messages");
      expect(fresh?.sessionId).toBeUndefined();
      expect(fresh?.prompt).toContain("Recent messages");
      const journals = sentOf("journal").map((m) => (m.payload as { text: string }).text);
      expect(journals[0]).toContain("Session restarted from journal");
      expect(types().indexOf("handback")).toBeGreaterThan(types().indexOf("journal"));
      expect(reports[0]).toMatchObject({ kind: "result", item: "c1" });
      await loop.stop();
      await conn.stop();
    });

    it("does not add the conversation to a resumed session", async () => {
      await connect();
      const { chat } = relay();
      const runtime = createFakeRuntime();
      start(runtime, { chat });
      socket.offerWith("c1", { origin: true, sessionId: "thread-session" });
      await until(() => sentOf("handback").length === 1);
      expect(runtime.requests[0]!.sessionId).toBe("thread-session");
      expect(runtime.requests[0]!.prompt).not.toContain("Recent messages");
      await loop.stop();
      await conn.stop();
    });

    it("tells the requester nothing while the item waits for a teammate's answer", async () => {
      await connect();
      const { chat, reports } = relay();
      const runtime: Runtime = {
        async *run(req) {
          yield { type: "started", sessionId: "s" };
          await req.tools
            .find((t) => t.name === "ask")!
            .handler({ to: "mira", question: "Which queue?" }, { workItemId: req.workItemId! });

          yield { type: "finished", ok: true, text: "Asked Mira." };
        },
      };

      start(runtime, { chat });
      socket.offerWith("c1", { origin: true });
      await until(() => sentOf("handback").length === 1);
      expect(sentOf("handback")[0]?.payload).toMatchObject({ status: "waiting" });
      expect(reports).toEqual([]);
      await loop.stop();
      await conn.stop();
    });

    it("tells the requester when the run fails", async () => {
      await connect();
      const { chat, reports } = relay();
      const runtime = createFakeRuntime();
      runtime.enqueue([{ type: "finish", ok: false, error: "model overloaded" }]);
      start(runtime, { chat });
      socket.offerWith("c1", { origin: true });
      await until(() => reports.length === 1);
      expect(reports[0]).toMatchObject({ kind: "failed", text: "model overloaded" });
      await loop.stop();
      await conn.stop();
    });

    it("does not report an item that was interrupted by a shutdown, nor one without a chat origin", async () => {
      await connect();
      const { chat, reports } = relay();
      const { runtime } = blockingRuntime();
      start(runtime, { chat });
      socket.offerWith("c1", { origin: true });
      await until(() => sentOf("progress").length === 1);
      await loop.stop();
      expect(sentOf("handback")[0]?.payload).toMatchObject({ status: "waiting" });
      expect(reports).toEqual([]);
      await conn.stop();
      await running;

      socket = new OfficeSocket();
      await connect();
      start(createFakeRuntime(), { chat });
      socket.offerWith("plain");
      await until(() => sentOf("handback").length === 1);
      expect(reports).toEqual([]);
      await loop.stop();
      await conn.stop();
    });

    it("carries on when reporting fails", async () => {
      await connect();
      const chat: Pick<ChatRelay, "context" | "report" | "acknowledge"> = {
        context: async () => undefined,
        acknowledge: async () => {},
        report: async () => {
          throw new Error("chat is down");
        },
      };

      start(createFakeRuntime(), { chat });
      socket.offerWith("c1", { origin: true });
      socket.offerWith("c2", { origin: true });
      await until(() => sentOf("handback").length === 2);
      expect(sentOf("fail")).toEqual([]);
      await loop.stop();
      await conn.stop();
    });
  });

  it("declines items left from before a restart so the office offers them again", async () => {
    await connect(["w9"]);
    start(createFakeRuntime());
    await until(() => sentOf("decline").length === 1);
    expect(sentOf("decline")[0]?.payload).toMatchObject({ workItemId: "w9" });
    expect(sentOf("fail")).toHaveLength(0);
    await loop.stop();
    await conn.stop();
  });

  describe("acknowledging feedback", () => {
    const REPO = { host: "git.acme.example", owner: "acme", name: "app" };

    async function prWithComments() {
      const { vcs } = fakeEnv();
      await vcs.seed.permission(REPO, "sam", "write");
      const pr = await vcs.seed.pullRequest(REPO, {
        title: "Search",
        author: { login: "sam", kind: "agent" },
      });

      const conversation = await vcs.seed.comment(REPO, pr.number, "dana", "Why this way?");
      const reviewId = await vcs.seed.review(REPO, pr.number, "dana", "changes_requested", "", [
        { path: "src/a.ts", line: 1, body: "rename" },
        { path: "src/b.ts", line: 2, body: "and this" },
      ]);

      const inline = await vcs.reviewComments(REPO, pr.number, reviewId);
      return { vcs, conversation, inline };
    }

    const eyes = (vcs: FakeVcs, conversation: string, inline: string[]) =>
      Promise.all([
        vcs.seed.reactions!(REPO, { kind: "conversation_comment", id: conversation }),
        ...inline.map((id) => vcs.seed.reactions!(REPO, { kind: "inline_comment", id })),
      ]);

    it("reacts once to each comment of the feedback before the run starts", async () => {
      await connect();
      const { vcs, conversation, inline } = await prWithComments();
      let reactedBeforeRun: unknown[] = [];
      const runtime: Runtime = {
        async *run() {
          reactedBeforeRun = await eyes(vcs, conversation, [inline[0]!.id, inline[1]!.id]);
          yield { type: "finished", ok: true, text: "Done." } satisfies RuntimeEvent;
        },
      };

      start(runtime, { vcs });
      socket.offerWith("w1", {
        kind: "review_feedback",
        feedback: [
          { actor: "dana", kind: "comment", body: "Why this way?", commentId: conversation },
          {
            actor: "dana",
            kind: "review",
            body: "",
            comments: inline.map((c) => ({ id: c.id, path: c.path, body: c.body })),
          },
          // The same comment twice (a repeated delivery) is one reaction.
          { actor: "dana", kind: "inline_comment", body: "rename", commentId: inline[0]!.id },
        ],
      });

      await until(() => types().includes("handback"));
      expect(reactedBeforeRun).toEqual([
        [{ user: "sam", reaction: "eyes" }],
        [{ user: "sam", reaction: "eyes" }],
        [{ user: "sam", reaction: "eyes" }],
      ]);
    });

    it("also reacts for merged_feedback, and not for other kinds of work", async () => {
      await connect();
      const { vcs, conversation } = await prWithComments();
      const calls: string[] = [];
      const react = vcs.react.bind(vcs);
      vcs.react = (repo, target, reaction) => {
        calls.push(`${target.kind}:${target.id}`);
        return react(repo, target, reaction);
      };

      const runtime = createFakeRuntime();
      runtime.enqueue([{ type: "finish", text: "Done." }]);
      runtime.enqueue([{ type: "finish", text: "Done." }]);
      start(runtime, { vcs });
      const feedback = [
        { actor: "dana", kind: "comment", body: "Late thought.", commentId: conversation },
      ];

      socket.offerWith("w1", { kind: "merged_feedback", feedback });
      await until(() => types().includes("handback"));
      socket.offerWith("w2", { kind: "ticket", feedback });
      await until(() => sentOf("handback").length === 2);
      expect(calls).toEqual([`conversation_comment:${conversation}`]);
    });

    it("does not react when policies.acknowledge.vcs is off, and still runs the round", async () => {
      await connect();
      const { vcs, conversation } = await prWithComments();
      const calls: string[] = [];
      vcs.react = async (_repo, target) => {
        calls.push(target.id);
      };

      const runtime = createFakeRuntime();
      runtime.enqueue([{ type: "finish", text: "Answered." }]);
      start(runtime, {
        vcs,
        policies: { acknowledge: { chat: true, vcs: false } } as TeamConfig["policies"],
      });

      socket.offerWith("w1", {
        kind: "review_feedback",
        feedback: [{ actor: "dana", kind: "comment", body: "Hm", commentId: conversation }],
      });

      await until(() => types().includes("handback"));
      expect(calls).toEqual([]);
      expect(sentOf("handback")[0]?.payload).toMatchObject({ status: "done" });
    });

    it("logs a warning when a reaction fails and still runs the round", async () => {
      await connect();
      const { vcs, conversation } = await prWithComments();
      vcs.react = async () => {
        throw new Error("Resource not accessible by integration");
      };

      const warnings: string[] = [];
      const log: Logger = {
        debug() {},
        info() {},
        warn: (message, fields) => void warnings.push(`${message} ${JSON.stringify(fields)}`),
        error() {},
      };

      const runtime = createFakeRuntime();
      runtime.enqueue([{ type: "finish", text: "Answered." }]);
      start(runtime, { vcs, log });
      socket.offerWith("w1", {
        kind: "review_feedback",
        feedback: [{ actor: "dana", kind: "comment", body: "Hm", commentId: conversation }],
      });

      await until(() => types().includes("handback"));
      expect(runtime.requests.length).toBeGreaterThan(0);
      expect(warnings).toEqual([expect.stringContaining("Resource not accessible")]);
      expect(sentOf("handback")[0]?.payload).toMatchObject({ status: "done" });
    });
  });
});

describe("linksIn", () => {
  it("finds urls once, without trailing punctuation", () => {
    expect(
      linksIn("See https://a.example/x, and (https://b.example/y). Again https://a.example/x."),
    ).toEqual([{ url: "https://a.example/x" }, { url: "https://b.example/y" }]);
  });
});

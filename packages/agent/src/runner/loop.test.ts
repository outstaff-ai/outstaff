import { buildPolicy, type RunRequest, type Runtime, type RuntimeEvent } from "@outstaff/core";
import { createFakeRuntime } from "@outstaff/core/fakes";
import type { Message } from "@outstaff/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createOfficeConnection, type OfficeConnection } from "../office-client/index.js";
import { FakeSocket, createManualClock, type ManualClientClock } from "../office-client/testing.js";
import { fakeEnv } from "../verbs/testing.js";
import type { Workspaces } from "../repos/index.js";
import { createWorkLoop, linksIn, type WorkLoop } from "./loop.js";

/** An office that acknowledges everything and says a question is still open. */
class OfficeSocket extends FakeSocket {
  override send(data: string) {
    super.send(data);
    const m = this.last();
    if (m.type === "hello") {
      return;
    }

    queueMicrotask(() =>
      m.type === "ask"
        ? this.reply(m, "ask_result", { id: "q1", to: m.payload.to, status: "pending" })
        : this.reply(m, "ack"),
    );
  }

  offerWith(id: string, extra: { sessionId?: string; journal?: boolean } = {}) {
    this.receive({
      id: `offer-${id}`,
      type: "offer",
      payload: {
        workItem: { id, kind: "ticket", title: `Fix ${id}`, priority: 1, trigger: "human" },
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
    extra: { progressEveryMs?: number; workspaces?: Workspaces } = {},
  ) {
    const { env } = fakeEnv();
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
      env: { ...env, office: conn },
      systemPrompt: "IDENTITY",
      policy,
      builtinTools: ["read", "ost"],
      workdir: "/home/sam/work",
      addDirs: ["/home/sam/repos"],
      model: "sonnet",
      now: () => clock.now().getTime(),
      ...extra,
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

    expect(types()).toEqual(["accept", "session", "progress", "handback"]);
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

  it("declines items left from before a restart so the office offers them again", async () => {
    await connect(["w9"]);
    start(createFakeRuntime());
    await until(() => sentOf("decline").length === 1);
    expect(sentOf("decline")[0]?.payload).toMatchObject({ workItemId: "w9" });
    expect(sentOf("fail")).toHaveLength(0);
    await loop.stop();
    await conn.stop();
  });
});

describe("linksIn", () => {
  it("finds urls once, without trailing punctuation", () => {
    expect(
      linksIn("See https://a.example/x, and (https://b.example/y). Again https://a.example/x."),
    ).toEqual([{ url: "https://a.example/x" }, { url: "https://b.example/y" }]);
  });
});

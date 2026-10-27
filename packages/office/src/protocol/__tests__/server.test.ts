import { PROTOCOL_VERSION, type Message } from "@outstaff/protocol";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { createAgentAuth, agentAuthFromSecrets, agentTokenKey } from "#/protocol/auth.js";
import { createProtocolServer } from "#/protocol/server.js";
import { ProtocolError } from "#/protocol/errors.js";
import type { ChatDesk, Messaging } from "#/protocol/source.types.js";
import { createFakeSource, type FakeSource } from "@outstaff/testing.office";
import type { ProtocolServer } from "#/protocol/types.js";

class Agent {
  readonly inbox: Message[] = [];
  closed: Promise<number>;
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("message", (d) => {
      this.inbox.push(JSON.parse(d.toString()) as Message);
      for (const w of this.waiters.splice(0)) {
        w();
      }
    });
  }

  static async connect(port: number): Promise<Agent> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    return new Agent(ws);
  }

  send(type: string, payload: unknown = {}, id = `t${++this.n}`) {
    this.ws.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  sendRaw(raw: string) {
    this.ws.send(raw);
  }

  /** The next message, optionally of a given type; earlier ones stay in the inbox. */
  async next(type?: string): Promise<Message> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex((m) => type === undefined || m.type === type);
      if (i >= 0) {
        return this.inbox.splice(i, 1)[0] as Message;
      }

      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${type ?? "a message"}`);
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async hello(person: string, token: string, version = PROTOCOL_VERSION) {
    return this.send("hello", {
      person,
      token,
      protocolVersion: version,
      agentVersion: "0.0.0-test",
    });
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

const tokens = { ada: "ada-secret", noor: "noor-secret" };

describe("protocol server", () => {
  let clock: ManualClock;
  let source: FakeSource;
  let server: ProtocolServer;
  let agents: Agent[];

  const connect = async () => {
    const a = await Agent.connect(server.port());
    agents.push(a);
    return a;
  };

  const login = async (person = "ada", token = tokens.ada as string) => {
    const a = await connect();
    await a.hello(person, token);
    await a.next("welcome");
    return a;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(async () => {
    clock = manualClock();
    source = createFakeSource([
      { handle: "ada", name: "Ada", role: "developer", status: "idle" },
      { handle: "noor", name: "Noor", role: "reviewer", status: "working", current: "ACME-1" },
    ]);

    agents = [];
    server = createProtocolServer({
      source,
      auth: createAgentAuth(tokens),
      clock,
      port: 0,
      host: "127.0.0.1",
      heartbeatMs: 1000,
      helloTimeoutMs: 500,
      pollMs: 100,
    });

    await server.start();
  });

  afterEach(async () => {
    for (const a of agents) {
      a.ws.terminate();
    }

    await server.stop();
  });

  describe("queued reports", () => {
    const report = {
      id: "w1:blocked:1",
      workItemId: "w1",
      kind: "blocked" as const,
      text: "Need the staging key.",
      requester: "U1",
      direct: "U1",
      links: [],
    };

    const withDesk = async (queued: ChatDesk["queued"], posted?: ChatDesk["posted"]) => {
      await server.stop();
      server = createProtocolServer({
        source,
        auth: createAgentAuth(tokens),
        clock,
        port: 0,
        host: "127.0.0.1",
        heartbeatMs: 1000,
        chat: { queued, posted: posted ?? (async () => {}) } as ChatDesk,
      });

      await server.start();
    };

    it("hands them to the agent in the welcome", async () => {
      await withDesk(async (person) => (person === "ada" ? [report] : []));
      const a = await connect();
      await a.hello("ada", tokens.ada);
      expect((await a.next("welcome")).payload).toMatchObject({ reports: [report] });
    });

    it("pushes them to a connected agent, and takes its confirmation", async () => {
      const confirmed: string[] = [];
      await withDesk(
        async () => [report],
        async (person, item, id) => void confirmed.push(`${person}:${item}:${id}`),
      );

      const a = await login();
      server.reports("ada");
      expect((await a.next("reports")).payload).toEqual({ reports: [report] });
      a.send("report_posted", { workItemId: "w1", id: "w1:blocked:1" });
      await a.next("ack");
      expect(confirmed).toEqual(["ada:w1:w1:blocked:1"]);
    });

    it("sends none when nothing is queued, and still welcomes the agent when the desk fails", async () => {
      await withDesk(async () => []);
      const a = await connect();
      await a.hello("ada", tokens.ada);
      expect((await a.next("welcome")).payload).not.toHaveProperty("reports");

      await withDesk(async () => {
        throw new Error("store down");
      });

      const b = await connect();
      await b.hello("ada", tokens.ada);
      expect((await b.next("welcome")).payload).not.toHaveProperty("reports");
    });
  });

  describe("authentication", () => {
    it("accepts a valid token and tells the agent how to behave", async () => {
      const a = await connect();
      const id = await a.hello("ada", tokens.ada);
      const welcome = await a.next("welcome");
      expect(welcome).toMatchObject({
        replyTo: id,
        payload: { protocolVersion: PROTOCOL_VERSION, heartbeatMs: 1000, resume: [] },
      });

      expect(server.connected()).toEqual(["ada"]);
    });

    it.each([
      ["a wrong token", "ada", "nope"],
      ["an unknown person", "zed", "ada-secret"],
      ["a person's token for someone else", "noor", "ada-secret"],
    ])("rejects %s and closes with 4401", async (_n, person, token) => {
      const a = await connect();
      await a.hello(person, token);
      expect(await a.next("error")).toMatchObject({ payload: { code: "auth_failed" } });
      expect(await a.closed).toBe(4401);
      expect(server.connected()).toEqual([]);
    });

    it("rejects a protocol version mismatch before checking the token", async () => {
      const a = await connect();
      await a.hello("ada", tokens.ada, PROTOCOL_VERSION + 1);
      expect(await a.next("error")).toMatchObject({ payload: { code: "version_mismatch" } });
      expect(await a.closed).toBe(4426);
    });

    it("requires hello first", async () => {
      const a = await connect();
      a.send("ping");
      expect(await a.next("error")).toMatchObject({ payload: { code: "unauthenticated" } });
      expect(await a.closed).toBe(4401);
    });

    it("closes a connection that never says hello", async () => {
      const a = await connect();
      clock.advance(500);
      expect(await a.next("error")).toMatchObject({ payload: { code: "unauthenticated" } });
      expect(await a.closed).toBe(4401);
    });

    it("hashes tokens from the office secrets", async () => {
      const secrets = {
        get: (k: string) => (k === "OUTSTAFF_AGENT_TOKEN_MIRA_LEE" ? "s3" : undefined),
        require: (k: string) => k,
      };

      const auth = agentAuthFromSecrets(secrets, ["mira-lee", "sam"]);
      expect(agentTokenKey("mira-lee")).toBe("OUTSTAFF_AGENT_TOKEN_MIRA_LEE");
      expect(await auth.verify("mira-lee", "s3")).toBe(true);
      expect(await auth.verify("mira-lee", "s4")).toBe(false);
      expect(await auth.verify("sam", "")).toBe(false);
      expect(auth.has("sam")).toBe(false);
    });
  });

  it("lets a new connection replace the old one", async () => {
    const first = await login();
    const second = await login();
    expect(await first.closed).toBe(4409);
    expect(first.inbox.some((m) => m.type === "error")).toBe(true);
    expect(server.connected()).toEqual(["ada"]);
    second.send("ping");
    expect(await second.next("pong")).toBeDefined();
    // The old socket closing must not drop the new connection.
    await settle();
    expect(server.connected()).toEqual(["ada"]);
  });

  it("drops an agent that stops talking", async () => {
    const a = await login();
    clock.advance(2999);
    a.send("heartbeat");
    await a.next("ack");
    clock.advance(2999);
    expect(server.connected()).toEqual(["ada"]);
    clock.advance(2);
    await a.closed;
    await settle();
    expect(server.connected()).toEqual([]);
  });

  describe("work", () => {
    it("takes an offer through accept, heartbeat, progress and hand-back", async () => {
      source.enqueue("ada", "w1", "Build the cart");
      source.enqueue("ada", "w2", "Fix the footer");
      const a = await login();
      const offer = await a.next("offer");
      expect(offer.payload).toMatchObject({ workItem: { id: "w1", title: "Build the cart" } });

      // The queue gives one item at a time.
      await settle();
      expect(a.inbox.filter((m) => m.type === "offer")).toEqual([]);

      const accept = a.send("accept", { workItemId: "w1", runtime: "claude" });
      expect(await a.next("ack")).toMatchObject({ replyTo: accept });
      a.send("heartbeat", { workItemId: "w1" });
      await a.next("ack");
      a.send("progress", { workItemId: "w1", text: "halfway" });
      await a.next("ack");
      a.send("journal", { workItemId: "w1", text: "chose a cookie" });
      await a.next("ack");
      const done = a.send("handback", {
        workItemId: "w1",
        summary: "Cart done",
        links: [{ url: "https://example.test/pr/1", title: "PR" }],
        status: "done",
      });

      expect(await a.next("ack")).toMatchObject({ replyTo: done });
      expect(source.stateOf("w1")).toBe("done");
      expect(source.journalLines).toEqual([{ id: "w1", text: "chose a cookie" }]);
      expect(source.handBacks[0]).toMatchObject({ id: "w1", summary: "Cart done", status: "done" });
      expect(source.calls).toEqual([
        "accept:ada:w1",
        "heartbeat:ada:w1",
        "progress:ada:w1",
        "journal:ada:w1",
        "handback:ada:w1",
      ]);

      // The next item follows the hand-back.
      expect((await a.next("offer")).payload).toMatchObject({ workItem: { id: "w2" } });
    });

    it("offers the next item after a failure, and requeues a declined one on the next poll", async () => {
      source.enqueue("ada", "w1");
      source.enqueue("ada", "w2");
      const a = await login();
      await a.next("offer");
      a.send("accept", { workItemId: "w1", runtime: "claude" });
      await a.next("ack");
      a.send("fail", { workItemId: "w1", reason: "no access" });
      await a.next("ack");
      expect(source.stateOf("w1")).toBe("failed");
      await a.next("offer");

      a.send("decline", { workItemId: "w2", reason: "busy" });
      await a.next("ack");
      expect(source.stateOf("w2")).toBe("queued");
      clock.advance(100);
      expect((await a.next("offer")).payload).toMatchObject({ workItem: { id: "w2" } });
    });

    it("delivers work that arrives later, on notify and on the poll", async () => {
      const a = await login();
      source.enqueue("ada", "w1");
      server.notify("ada");
      expect((await a.next("offer")).payload).toMatchObject({ workItem: { id: "w1" } });
      a.send("accept", { workItemId: "w1", runtime: "claude" });
      await a.next("ack");
      a.send("handback", { workItemId: "w1", summary: "ok", links: [], status: "waiting" });
      await a.next("ack");
      source.enqueue("ada", "w2");
      clock.advance(100);
      expect((await a.next("offer")).payload).toMatchObject({ workItem: { id: "w2" } });
    });

    it("sends an offer again after a disconnect until it is accepted", async () => {
      source.enqueue("ada", "w1");
      const first = await login();
      await first.next("offer");
      await first.close();
      await settle();

      const second = await login();
      const again = await second.next("offer");
      expect(again.payload).toMatchObject({ workItem: { id: "w1" } });

      // Not repeated on the same connection by the poll.
      clock.advance(300);
      await settle();
      expect(second.inbox.filter((m) => m.type === "offer")).toEqual([]);

      // Accepting twice is harmless.
      second.send("accept", { workItemId: "w1", runtime: "claude" });
      second.send("accept", { workItemId: "w1", runtime: "claude" });
      await second.next("ack");
      await second.next("ack");

      // Once accepted it is resumed, not offered.
      await second.close();
      await settle();
      const third = await connect();
      await third.hello("ada", tokens.ada);
      expect((await third.next("welcome")).payload).toMatchObject({ resume: ["w1"] });
      await settle();
      expect(third.inbox.filter((m) => m.type === "offer")).toEqual([]);
    });

    it("answers roster and work requests", async () => {
      source.enqueue("ada", "w1");
      source.enqueue("noor", "w9");
      const a = await login();
      await a.next("offer");
      a.send("roster");
      expect((await a.next("roster_result")).payload).toMatchObject({
        members: [{ handle: "ada" }, { handle: "noor", current: "ACME-1" }],
      });

      a.send("work_list", { workItemId: "w1" });
      expect((await a.next("work_list_result")).payload).toEqual({
        items: [{ id: "w1", title: "Item w1", status: "offered", current: true }],
      });

      a.send("work_status", { workItemIds: ["w1", "w9", "w0"] });
      expect((await a.next("work_status_result")).payload).toEqual({
        items: [
          { workItemId: "w1", state: "active" },
          { workItemId: "w9", state: "not_yours" },
          { workItemId: "w0", state: "unknown" },
        ],
      });

      a.send("work_move", { workItemId: "w1", status: "blocked" });
      expect((await a.next("work_move_result")).payload).toMatchObject({
        item: { id: "w1", status: "blocked" },
      });

      a.send("work_move", { workItemId: "w9", status: "blocked" });
      expect((await a.next("error")).payload).toMatchObject({ code: "unknown_item" });
    });

    it("answers ping with pong", async () => {
      const a = await login();
      const id = a.send("ping");
      expect(await a.next("pong")).toMatchObject({ replyTo: id });
    });
  });

  describe("bad input", () => {
    it("answers malformed, unknown and invalid messages with errors and keeps going", async () => {
      const a = await login();
      a.sendRaw("{not json");
      expect((await a.next("error")).payload).toMatchObject({ code: "malformed" });
      a.sendRaw("[1]");
      expect((await a.next("error")).payload).toMatchObject({ code: "malformed" });
      a.sendRaw(JSON.stringify({ id: "x1", payload: {} }));
      expect((await a.next("error")).payload).toMatchObject({ code: "malformed" });

      a.sendRaw(JSON.stringify({ id: "x2", type: "launch_missiles", payload: {} }));
      expect(await a.next("error")).toMatchObject({
        replyTo: "x2",
        payload: { code: "unknown_type" },
      });

      a.sendRaw(JSON.stringify({ id: "x3", type: "accept", payload: { workItemId: 5 } }));
      expect(await a.next("error")).toMatchObject({
        replyTo: "x3",
        payload: { code: "invalid_message" },
      });

      a.sendRaw(JSON.stringify({ id: "x4", type: "offer", payload: {} }));
      expect((await a.next("error")).payload).toMatchObject({ code: "invalid_message" });
      a.sendRaw(
        JSON.stringify({
          id: "x5",
          type: "ack",
          payload: {},
        }),
      );

      expect(await a.next("error")).toMatchObject({ replyTo: "x5", payload: { code: "invalid" } });

      a.sendRaw(
        JSON.stringify({
          id: "x6",
          type: "hello",
          payload: { person: "ada", token: "ada-secret", protocolVersion: 1, agentVersion: "1" },
        }),
      );

      expect((await a.next("error")).payload).toMatchObject({ code: "invalid" });

      a.send("ping");
      expect(await a.next("pong")).toBeDefined();
      expect(server.connected()).toEqual(["ada"]);
    });

    it("hides unexpected source failures and passes coded ones through", async () => {
      source.enqueue("ada", "w1");
      const a = await login();
      await a.next("offer");
      source.failNext(new Error("database password is hunter2"));
      a.send("accept", { workItemId: "w1", runtime: "claude" });
      const err = await a.next("error");
      expect(err.payload).toMatchObject({ code: "failed" });
      expect(JSON.stringify(err)).not.toContain("hunter2");

      source.failNext(new ProtocolError("invalid", "Cannot do that."));
      a.send("accept", { workItemId: "w1", runtime: "claude" });
      expect((await a.next("error")).payload).toEqual({
        code: "invalid",
        message: "Cannot do that.",
      });
    });

    it("says ask is unsupported without messaging", async () => {
      const a = await login();
      a.send("ask", { to: "noor", question: "Ok?" });
      expect((await a.next("error")).payload).toMatchObject({ code: "unsupported" });
    });

    it("says ticket_prs is unsupported without a ticket desk", async () => {
      const a = await login("ada", tokens.ada);
      a.send("ticket_prs", { headRef: "feat/x", title: "x", body: "" });
      expect((await a.next("error")).payload).toMatchObject({ code: "unsupported" });
    });

    it("says doctor_report is unsupported without a doctor", async () => {
      const a = await login("ada", tokens.ada);
      a.send("doctor_report", { checks: [] });
      expect((await a.next("error")).payload).toMatchObject({ code: "unsupported" });
    });

    it("says doc_link is unsupported without a document desk", async () => {
      const a = await login("ada", tokens.ada);
      a.send("doc_link", { workItemId: "w1", doc: { id: "d1", title: "T", url: "https://x/d1" } });
      expect((await a.next("error")).payload).toMatchObject({ code: "unsupported" });
    });
  });
});

describe("protocol server with a document desk", () => {
  it("passes the document and the caller to the desk, and says what it refuses", async () => {
    const linked: unknown[] = [];
    const server = createProtocolServer({
      source: createFakeSource(),
      docs: {
        async link(person, workItemId, doc) {
          if (workItemId === "other") {
            throw new ProtocolError("unknown_item", "No work item other for ada.");
          }

          linked.push({ person, workItemId, doc });
        },
      },
      auth: createAgentAuth(tokens),
      clock: manualClock(),
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    const a = await Agent.connect(server.port());
    await a.hello("ada", tokens.ada);
    await a.next("welcome");
    const doc = { id: "d1", title: "Cart design", url: "https://docs.acme.example/d1" };
    a.send("doc_link", { workItemId: "w1", doc });
    expect(await a.next("ack")).toBeDefined();
    expect(linked).toEqual([{ person: "ada", workItemId: "w1", doc }]);

    a.send("doc_link", { workItemId: "other", doc });
    expect((await a.next("error")).payload).toMatchObject({ code: "unknown_item" });
    a.ws.terminate();
    await server.stop();
  });
});

describe("protocol server with a doctor", () => {
  it("passes the checks an agent reports and the caller to the doctor", async () => {
    const reported: unknown[] = [];
    const server = createProtocolServer({
      source: createFakeSource(),
      doctor: {
        async report(person, checks) {
          reported.push({ person, checks });
        },
      },
      auth: createAgentAuth(tokens),
      clock: manualClock(),
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    const a = await Agent.connect(server.port());
    await a.hello("ada", tokens.ada);
    await a.next("welcome");
    const checks = [
      { name: "Tools install", status: "ok" as const, detail: "jq@1.7.1 installed." },
    ];

    a.send("doctor_report", { checks });
    expect(await a.next("ack")).toBeDefined();
    expect(reported).toEqual([{ person: "ada", checks }]);
    a.ws.terminate();
    await server.stop();
  });
});

describe("protocol server with a ticket desk", () => {
  it("answers which ticket a pull request would link to and what it has", async () => {
    const asked: unknown[] = [];
    const server = createProtocolServer({
      source: createFakeSource(),
      tickets: {
        async forDraft(draft) {
          asked.push(draft);
          return {
            ticket: "ACME-1",
            prs: [
              {
                ref: "acme/app#3",
                number: 3,
                title: "ACME-1: x",
                state: "open",
                authorKind: "agent",
              },
            ],
          };
        },
      },
      auth: createAgentAuth(tokens),
      clock: manualClock(),
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    const a = await Agent.connect(server.port());
    await a.hello("ada", tokens.ada);
    await a.next("welcome");
    a.send("ticket_prs", { headRef: "feat/x", title: "x", body: "Closes ACME-1" });
    expect((await a.next("ticket_prs_result")).payload).toMatchObject({
      ticket: "ACME-1",
      prs: [{ number: 3, state: "open" }],
    });

    expect(asked).toEqual([{ headRef: "feat/x", title: "x", body: "Closes ACME-1" }]);
    a.ws.terminate();
    await server.stop();
  });
});

describe("protocol server with messaging", () => {
  it("routes ask and answer", async () => {
    const asked: unknown[] = [];
    const messaging: Messaging = {
      async ask(from, q) {
        asked.push({ from, ...q });
        return { id: "q1", to: q.to, status: "pending" };
      },
      async answer(from, id, answer) {
        asked.push({ from, id, answer });
      },
    };

    const server = createProtocolServer({
      source: createFakeSource(),
      messaging,
      auth: createAgentAuth(tokens),
      clock: manualClock(),
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    const a = await Agent.connect(server.port());
    await a.hello("ada", tokens.ada);
    await a.next("welcome");
    a.send("ask", { to: "noor", question: "Ok?", workItemId: "w1" });
    expect((await a.next("ask_result")).payload).toEqual({
      id: "q1",
      to: "noor",
      status: "pending",
    });

    a.send("answer", { questionId: "q9", answer: "Yes" });
    await a.next("ack");
    expect(asked).toEqual([
      { from: "ada", to: "noor", question: "Ok?", workItemId: "w1" },
      { from: "ada", id: "q9", answer: "Yes" },
    ]);

    a.ws.terminate();
    await server.stop();
  });
});

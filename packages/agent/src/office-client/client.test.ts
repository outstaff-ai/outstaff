import { PROTOCOL_VERSION } from "@outstaff/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createOfficeConnection, type OfficeConnection } from "./client.js";
import { FakeSocket, createManualClock, type ManualClientClock } from "./testing.js";

describe("office connection", () => {
  let clock: ManualClientClock;
  let sockets: FakeSocket[];
  let conn: OfficeConnection;

  const make = (extra: { random?: () => number; requestTimeoutMs?: number } = {}) => {
    conn = createOfficeConnection({
      url: "ws://office.test/agent",
      person: "ada",
      token: "t",
      agentVersion: "1.2.3",
      clock,
      random: () => 1,
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      ...extra,
    });
  };

  const current = () => sockets.at(-1) as FakeSocket;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const connectUp = async (opts?: Parameters<FakeSocket["welcome"]>[0]) => {
    conn.start();
    current().open();
    current().welcome(opts);
    await conn.whenConnected();
  };

  beforeEach(() => {
    clock = createManualClock();
    sockets = [];
    make();
  });

  it("says hello and becomes connected on welcome", async () => {
    conn.start();
    expect(conn.state()).toBe("connecting");
    current().open();
    expect(current().sent[0]).toMatchObject({
      type: "hello",
      payload: {
        person: "ada",
        token: "t",
        protocolVersion: PROTOCOL_VERSION,
        agentVersion: "1.2.3",
      },
    });

    current().welcome({ resume: ["w7"] });
    await conn.whenConnected();
    expect(conn.state()).toBe("connected");
    expect(conn.resume()).toEqual(["w7"]);
  });

  it("reconnects with exponential backoff, capped, and resets after a welcome", async () => {
    conn.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = sockets.length;
      current().drop();
      expect(conn.state()).toBe("backoff");
      let waited = 0;
      while (sockets.length === before) {
        clock.advance(100);
        waited += 100;
      }

      delays.push(waited);
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    current().open();
    current().welcome();
    await conn.whenConnected();
    const before = sockets.length;
    current().drop();
    clock.advance(1000);
    expect(sockets.length).toBe(before + 1);
  });

  it("spreads reconnects with jitter between half and the full delay", () => {
    make({ random: () => 0 });
    conn.start();
    current().drop();
    clock.advance(499);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
  });

  it("does not reconnect after the office refuses it", async () => {
    conn.start();
    current().open();
    const waiting = conn.whenConnected();
    const hello = current().sentOf("hello")[0];
    current().reply(hello!, "error", { code: "auth_failed", message: "Wrong token." });
    current().drop(4401);
    await expect(waiting).rejects.toThrow(/Wrong token/);
    expect(conn.state()).toBe("rejected");
    expect(conn.rejection()).toEqual({ code: "auth_failed", message: "Wrong token." });
    clock.advance(120_000);
    expect(sockets).toHaveLength(1);
  });

  it("stays away when another connection replaced it", async () => {
    await connectUp();
    current().receive({ id: "o9", type: "error", payload: { code: "replaced", message: "x" } });
    current().drop(4409);
    clock.advance(120_000);
    expect(conn.state()).toBe("rejected");
    expect(sockets).toHaveLength(1);
  });

  it("sends heartbeats with the active item and reconnects when the office goes quiet", async () => {
    await connectUp({ heartbeatMs: 1000 });
    const accept = conn.accept("w1");
    current().reply(current().last(), "ack");
    await accept;

    clock.advance(1000);
    const beat = current().sentOf("heartbeat")[0];
    expect(beat?.payload).toEqual({ workItemId: "w1" });
    current().reply(beat!, "ack");
    await flush();

    clock.advance(1000);
    expect(current().sentOf("heartbeat")).toHaveLength(2);
    const first = current();
    clock.advance(1000);
    await flush();
    expect(first.terminated).toBe(true);
    clock.advance(1000);
    expect(sockets).toHaveLength(2);
  });

  it("streams offers and drops a repeat of one nobody has taken", async () => {
    await connectUp();
    const stream = conn.offers()[Symbol.asyncIterator]();
    const first = stream.next();
    current().offer("w1");
    expect((await first).value?.workItem.id).toBe("w1");

    current().offer("w2");
    current().offer("w2");
    current().offer("w3");
    expect((await stream.next()).value?.workItem.id).toBe("w2");
    expect((await stream.next()).value?.workItem.id).toBe("w3");

    // After it was taken, a redelivery after reconnect is handed out again.
    current().offer("w2");
    expect((await stream.next()).value?.workItem.id).toBe("w2");
    await conn.stop();
    expect((await stream.next()).done).toBe(true);
  });

  it("answers an office ping", async () => {
    await connectUp();
    current().receive({ id: "p1", type: "ping", payload: {} });
    expect(current().last()).toMatchObject({ type: "pong", replyTo: "p1" });
  });

  describe("requests", () => {
    it("maps chat messages, reports, placement and current work onto the protocol", async () => {
      await connectUp();
      const message = conn.chatMessage({
        messageId: "m1",
        channel: "D1",
        text: "hi",
        author: { id: "U1" },
      });

      expect(current().last()).toMatchObject({
        type: "chat_message",
        payload: { messageId: "m1" },
      });

      const result = {
        disposition: "started",
        repeated: false,
        item: { id: "c1", title: "hi", status: "queued" },
        links: [],
        work: [],
      };

      current().reply(current().last(), "chat_message_result", result);
      expect(await message).toEqual(result);

      const report = conn.chatReport("c1", "result");
      expect(current().last()).toMatchObject({
        type: "chat_report",
        payload: { workItemId: "c1", kind: "result" },
      });

      current().reply(current().last(), "chat_report_result", { post: true, links: [] });
      expect(await report).toEqual({ post: true, links: [] });

      const place = conn.place("c1", { position: "after", relativeTo: "w2" });
      expect(current().last()).toMatchObject({
        type: "work_place",
        payload: { workItemId: "c1", position: "after", relativeTo: "w2" },
      });

      current().reply(current().last(), "work_move_result", {
        item: { id: "c1", title: "hi", status: "queued" },
      });

      expect(await place).toEqual({ id: "c1", title: "hi", status: "queued" });

      const work = conn.currentWork();
      current().reply(current().last(), "current_work_result", { text: "Ticket ACME-1" });
      expect(await work).toBe("Ticket ACME-1");
    });

    it("maps ask, work and team onto the protocol", async () => {
      await connectUp();
      const ask = conn.ask({ to: "noor", question: "Ok?", workItemId: "w1" });
      const req = current().last();
      expect(req).toMatchObject({
        type: "ask",
        payload: { to: "noor", question: "Ok?", workItemId: "w1" },
      });

      current().reply(req, "ask_result", {
        id: "q1",
        to: "noor",
        status: "answered",
        answer: "Yes",
      });

      expect(await ask).toEqual({ id: "q1", to: "noor", status: "answered", answer: "Yes" });

      const work = conn.work({});
      current().reply(current().last(), "work_list_result", {
        items: [{ id: "w1", title: "T", status: "active" }],
      });

      expect(await work).toEqual([{ id: "w1", title: "T", status: "active" }]);

      const team = conn.team();
      expect(current().last().type).toBe("roster");
      current().reply(current().last(), "roster_result", { members: [] });
      expect(await team).toEqual({ members: [], humans: [] });
    });

    it("turns error replies into port errors", async () => {
      await connectUp();
      const p = conn.accept("nope");
      current().reply(current().last(), "error", {
        code: "unknown_item",
        message: "No such item.",
      });

      await expect(p).rejects.toMatchObject({ code: "not_found", message: "No such item." });
    });

    it("waits for a reconnect, and fails pending requests when the connection drops", async () => {
      await connectUp();
      const lost = conn.team();
      current().drop();
      await expect(lost).rejects.toMatchObject({ code: "unavailable" });

      const later = conn.team();
      clock.advance(1000);
      current().open();
      current().welcome();
      await flush();
      expect(current().last().type).toBe("roster");
      current().reply(current().last(), "roster_result", { members: [] });
      expect(await later).toEqual({ members: [], humans: [] });
    });

    it("times out when nobody answers or the office is unreachable", async () => {
      make({ requestTimeoutMs: 500 });
      await connectUp();
      const silent = conn.team();
      clock.advance(500);
      await expect(silent).rejects.toThrow(/did not answer roster/);

      current().drop();
      const unreachable = conn.team();
      clock.advance(500);
      await expect(unreachable).rejects.toThrow(/Could not reach/);
    });

    it("refuses when stopped", async () => {
      await connectUp();
      await conn.stop();
      expect(conn.state()).toBe("stopped");
      await expect(conn.team()).rejects.toMatchObject({ code: "unavailable" });
      clock.advance(60_000);
      expect(sockets).toHaveLength(1);
    });
  });

  it("hands back with default links and clears the active item", async () => {
    await connectUp();
    const p = conn.handBack("w1", { summary: "Done", status: "done" });
    expect(current().last()).toMatchObject({
      type: "handback",
      payload: { workItemId: "w1", summary: "Done", status: "done", links: [] },
    });

    current().reply(current().last(), "ack");
    await p;
  });
});

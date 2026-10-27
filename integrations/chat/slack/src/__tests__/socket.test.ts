import type { EventEmitter } from "node:events";
import { silentLogger, type ChatMessage } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { createSlackChat } from "#/chat.js";
import { createSocketModeSocket } from "#/socket.js";
import { createFakeSlack } from "#/testing/slack-fake.js";
import { secretMap } from "#/testing/harness.js";

interface Client extends EventEmitter {
  options: { appToken: string };
  started: number;
  disconnected: number;
}

const { clients, FakeClient } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const clients: Client[] = [];
  class FakeClient extends EventEmitter {
    started = 0;
    disconnected = 0;
    constructor(readonly options: { appToken: string }) {
      super();
      clients.push(this);
    }

    async start() {
      this.started++;
    }

    async disconnect() {
      this.disconnected++;
    }
  }

  return { clients, FakeClient };
});

vi.mock("@slack/socket-mode", () => ({ SocketModeClient: FakeClient }));

/** What Socket Mode hands over: an envelope to acknowledge, carrying an Events API payload. */
const envelope = (type: string, event?: object) => {
  const acked: string[] = [];
  return {
    acked,
    type,
    ...(event ? { body: { event } } : {}),
    ack: async () => void acked.push("ack"),
  };
};

const deliver = async (client: Client, e: ReturnType<typeof envelope>) => {
  await Promise.all(client.listeners("slack_event").map((l) => l(e)));
};

describe("createSocketModeSocket", () => {
  it("connects with the app token and disconnects on stop", async () => {
    const socket = createSocketModeSocket("xapp-1");
    const client = clients.at(-1)!;
    expect(client.options).toEqual({ appToken: "xapp-1" });
    await socket.start();
    await socket.stop();
    expect([client.started, client.disconnected]).toEqual([1, 1]);
  });

  it("acknowledges an envelope before handing its event to the handler", async () => {
    const socket = createSocketModeSocket("xapp-1");
    const client = clients.at(-1)!;
    const order: string[] = [];
    const seen: unknown[] = [];
    socket.onEvent(async (e) => {
      order.push("handler");
      seen.push(e);
    });

    const e = envelope("events_api", { type: "app_mention", text: "hi" });
    e.ack = async () => void order.push("ack");
    await deliver(client, e);
    expect(order).toEqual(["ack", "handler"]);
    expect(seen).toEqual([{ type: "app_mention", text: "hi" }]);
  });

  it("acknowledges but ignores envelopes that are not events or carry none", async () => {
    const socket = createSocketModeSocket("xapp-1");
    const client = clients.at(-1)!;
    const handler = vi.fn<(e: unknown) => Promise<void>>(async () => {});
    socket.onEvent(handler);
    const slash = envelope("slash_commands", { type: "message" });
    const empty = envelope("events_api");
    await deliver(client, slash);
    await deliver(client, empty);
    expect(slash.acked).toEqual(["ack"]);
    expect(empty.acked).toEqual(["ack"]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a chat without an injected socket", () => {
  it("opens Socket Mode with the app token, delivers its events and disconnects on stop", async () => {
    const fake = createFakeSlack();
    const chat = createSlackChat(
      {
        options: {},
        secrets: secretMap({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-9" }),
        team: { people: [] } as never,
        log: silentLogger,
        fetch: fake.fetch,
        now: () => new Date("2026-01-01T00:00:00Z"),
      },
      { web: fake.web },
    );

    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    const received: ChatMessage[] = [];
    await chat.start(async (m) => void received.push(m));
    const client = clients.at(-1)!;
    expect(client.options).toEqual({ appToken: "xapp-9" });
    expect(client.started).toBe(1);
    await deliver(
      client,
      envelope("events_api", {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U-noor",
        text: "hello",
        ts: "1767225600.000001",
      }),
    );

    expect(received.map((m) => m.text)).toEqual(["hello"]);
    await chat.stop();
    expect(client.disconnected).toBe(1);
  });
});

import {
  parseTeamConfig,
  silentLogger,
  type Chat,
  type ChatMessage,
  type Logger,
  type TeamConfig,
} from "@outstaff/core";
import { createFakeChat } from "@outstaff/core/fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeOffice } from "#/verbs/office.js";
import type { FakeOffice } from "#/verbs/office.types.js";
import { CATCH_UP_LIMIT, catchUp, offlineNote } from "#/runner/chat-catch-up.js";
import { createChatRelay } from "#/runner/chat.js";
import type { ChatRelay } from "#/runner/chat.types.js";

const DM = "D-U0DANA0001";

function team(policies?: Record<string, unknown>): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake", project: "ACME" },
    },
    ...(policies ? { policies } : {}),
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

/** The fake chat's clock steps a second per message from here; the relay's clock is set by each test. */
const START = Date.parse("2030-01-01T00:00:00.000Z");

describe("catching up on chat when the agent connects", () => {
  let chat: ReturnType<typeof createFakeChat>;
  let office: FakeOffice;
  let now: Date;
  let relay: ChatRelay | undefined;

  const connect = async (policies?: Record<string, unknown>) => {
    relay = createChatRelay({
      chat,
      office,
      team: team(policies),
      person: "sam",
      log: silentLogger,
      now: () => now,
    });

    await relay.start();
  };

  const disconnect = async () => {
    await relay?.stop();
  };

  const dana = (text: string, thread?: string) =>
    chat.seed.inbound({
      channel: DM,
      authorId: "U0DANA0001",
      authorName: "Dana",
      text,
      ...(thread ? { thread } : {}),
    });

  const taken = () => office.chatMessages.map((m) => m.text);

  beforeEach(() => {
    chat = createFakeChat();
    office = createFakeOffice();
    now = new Date(START + 3_600_000);
  });

  it("takes in a message written during a disconnect once, on reconnect, and not one already handled", async () => {
    await connect();
    await dana("hello");
    expect(taken()).toEqual(["hello"]);

    await disconnect();
    const offline = await dana("can you retry", "m1");
    await connect();
    await vi.waitFor(() => expect(taken()).toEqual(["hello", "can you retry"]));
    expect(office.chatMessages[1]).toMatchObject({
      messageId: offline.id,
      thread: "m1",
      at: offline.at,
    });

    // The office has both now: connecting again picks up nothing, and nothing is said.
    await disconnect();
    await connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(taken()).toEqual(["hello", "can you retry"]);
    expect(chat.posts).toEqual([]);
  });

  it("marks a picked-up message seen only when the office takes it in for the first time", async () => {
    await connect();
    await disconnect();
    const fresh = await dana("new to the office");
    const known = await dana("the office has this one", "t1");
    // The office took it in once already, but its cursor was lost: catching up hands it over again.
    await office.chatMessage({
      messageId: known.id,
      channel: DM,
      thread: "t1",
      text: known.text,
      author: { id: "U0DANA0001" },
      at: "2029-01-01T00:00:00.000Z",
      direct: true,
      participant: true,
    });

    await connect();
    await vi.waitFor(() => expect(office.chatMessages).toHaveLength(3));
    await vi.waitFor(() =>
      expect(chat.reactions).toEqual([{ channel: DM, messageId: fresh.id, name: "eyes" }]),
    );
  });

  it("keeps the cursor at the office, so a new agent process with a new chat connection skips what was handled", async () => {
    await connect();
    await dana("first");
    await disconnect();

    // A restart: a fresh relay on the same office, and the chat still holds the earlier message.
    relay = undefined;
    await connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(taken()).toEqual(["first"]);
  });

  it("picks up the latest messages per conversation, oldest first, and says once how many it left out", async () => {
    await connect();
    await dana("start");
    await disconnect();
    for (let i = 1; i <= CATCH_UP_LIMIT + 2; i++) {
      await dana(`offline ${i}`);
    }

    await connect();
    await vi.waitFor(() => expect(taken()).toHaveLength(1 + CATCH_UP_LIMIT));
    expect(taken().slice(1)).toEqual(
      Array.from({ length: CATCH_UP_LIMIT }, (_, i) => `offline ${i + 3}`),
    );

    expect(chat.posts.map((p) => [p.channel, p.thread, p.text])).toEqual([
      [
        DM,
        // The fake answers in a thread of the note itself when it is top-level.
        chat.posts[0]!.id,
        "I was offline; I've picked up your last 10 messages here. 2 earlier ones I did not pick up: ask again if you still need them.",
      ],
    ]);
  });

  it("does not go further back than catch_up_hours, and says so where the conversation had a cursor", async () => {
    await connect();
    await dana("start", "t1");
    await disconnect();
    await dana("old one", "t1");
    // Two days later; the team looks back 24 hours.
    now = new Date(START + 48 * 3_600_000);
    await connect();
    await vi.waitFor(() => expect(chat.posts).toHaveLength(1));
    expect(taken()).toEqual(["start"]);
    expect(chat.posts[0]).toMatchObject({
      channel: DM,
      thread: "t1",
      text: "I was offline; 1 message here was too old to pick up: ask again if you still need it.",
    });
  });

  it("is off with catch_up_hours 0", async () => {
    await connect();
    await dana("start");
    await disconnect();
    await dana("missed");
    await connect({ chat: { catch_up_hours: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(taken()).toEqual(["start"]);
  });
});

describe("catchUp", () => {
  const deps = <O extends Partial<Parameters<typeof catchUp>[0]>>(over: O) => ({
    chat: {} as Pick<Chat, "missedSince">,
    office: { chatCursors: async () => [] },
    hours: 24,
    log: { ...silentLogger, warn: vi.fn<Logger["warn"]>() },
    now: () => new Date(START),
    take: vi.fn<(m: ChatMessage) => Promise<void>>(async () => {}),
    post: vi.fn<(channel: string, thread: string | undefined, text: string) => Promise<void>>(
      async () => {},
    ),
    ...over,
  });

  it("does nothing for a chat that cannot catch up", async () => {
    const d = deps({ office: { chatCursors: vi.fn<() => Promise<[]>>(async () => []) } });
    await catchUp(d);
    expect(d.office.chatCursors).not.toHaveBeenCalled();
  });

  it("asks from the cursors and the window, and never throws", async () => {
    const missedSince = vi.fn<NonNullable<Chat["missedSince"]>>(async () => {
      throw new Error("rate limited");
    });

    const cursors = [{ channel: DM, at: "2029-12-31T12:00:00.000Z" }];
    const d = deps({ chat: { missedSince }, office: { chatCursors: async () => cursors } });
    await expect(catchUp(d)).resolves.toBeUndefined();
    expect(missedSince).toHaveBeenCalledWith({
      cursors,
      since: "2029-12-31T00:00:00.000Z",
      limit: CATCH_UP_LIMIT,
    });

    expect(d.log.warn).toHaveBeenCalledWith("could not catch up on chat", {
      error: "rate limited",
    });
  });

  it("puts every conversation's messages in time order, and notes a channel's in the thread of its latest", async () => {
    const at = (s: number) => new Date(START + s * 1000).toISOString();
    const msg = (id: string, channel: string, s: number) => ({
      id,
      channel,
      author: { id: "U1", trusted: true, bot: false },
      text: id,
      at: at(s),
    });

    const d = deps({
      chat: {
        missedSince: async () => [
          { channel: "C1", messages: [msg("c2", "C1", 2), msg("c4", "C1", 4)], skipped: 1 },
          { channel: DM, direct: true, messages: [msg("d1", DM, 1), msg("d3", DM, 3)], skipped: 0 },
        ],
      },
    });

    await catchUp(d);
    expect(d.take.mock.calls.map(([m]) => m.id)).toEqual(["d1", "c2", "d3", "c4"]);

    expect(d.post).toHaveBeenCalledWith("C1", "c4", expect.stringContaining("last 2 messages"));
  });

  it("words the note by how many it picked up and left out", () => {
    expect(offlineNote({ messages: [], skipped: 3 })).toBe(
      "I was offline; 3 messages here were too old to pick up: ask again if you still need them.",
    );

    const one = {
      id: "m",
      channel: DM,
      author: { id: "U", trusted: true, bot: false },
      text: "",
      at: "",
    };

    expect(offlineNote({ messages: [one], skipped: 1 })).toBe(
      "I was offline; I've picked up your last 1 message here. 1 earlier one I did not pick up: ask again if you still need it.",
    );
  });
});

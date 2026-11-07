import type { ChatMissedOptions, TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { slackWith, teamWith } from "./support/harness.js";
import { BOT_USER } from "./support/slack-fake.js";

const ADA = "U0ADA00001";
const GUEST = "U0GUEST001";
const DM = `D-${ADA}`;
const CHANNEL = "C-general";

/** The fake's first timestamp is 2026-01-01T00:00:00Z and each message is one second later. */
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const SINCE = at(-60);

function setup(team: TeamConfig = teamWith([ADA])) {
  const warnings: string[] = [];
  const s = slackWith(team, (m) => warnings.push(m));
  s.fake.users.set(ADA, { id: ADA, name: "ada" });
  s.fake.users.set(GUEST, { id: GUEST, name: "guest" });
  s.fake.users.set("U0OTHERBOT", { id: "U0OTHERBOT", name: "other", is_bot: true });
  const ada = (channel: string, text: string, thread?: string) =>
    s.fake.write(channel, { user: ADA, text, ...(thread ? { thread_ts: thread } : {}) });

  const missed = (opts: Partial<ChatMissedOptions> = {}) =>
    s.chat.missedSince!({ cursors: [], since: SINCE, limit: 10, ...opts });

  return { ...s, warnings, ada, missed };
}

const texts = (c: { messages: { text: string }[] }) => c.messages.map((m) => m.text);

describe("catching up on what was written while the agent was offline", () => {
  it("reads a direct message with no cursor since the window, and its threads with replies", async () => {
    const s = setup();
    const parent = s.ada(DM, "the build is red");
    s.ada(DM, "can you retry", parent);
    s.ada(DM, "and one more thing");

    const missed = await s.missed();
    expect(missed.map((c) => [c.channel, c.thread, c.direct, texts(c), c.skipped])).toEqual([
      [DM, undefined, true, ["the build is red", "and one more thing"], 0],
      [DM, parent, true, ["can you retry"], 0],
    ]);

    // The parent is a top-level message, though history lists it with its thread.
    expect(missed[0]!.messages[0]).toMatchObject({
      id: parent,
      channel: DM,
      author: { id: ADA, name: "ada", trusted: true, bot: false },
      at: at(0),
      direct: true,
    });

    expect(missed[0]!.messages[0]!.thread).toBeUndefined();
    expect(missed[1]!.messages[0]!.thread).toBe(parent);
    expect(s.fake.historyCalls).toEqual([{ channel: DM, oldest: "1767225540.000000" }]);
    expect(s.fake.repliesCalls).toEqual([{ channel: DM, ts: parent, oldest: "1767225540.000000" }]);
  });

  it("starts after each cursor, so what the office took in already is not returned", async () => {
    const s = setup();
    const first = s.ada(DM, "handled");
    s.ada(DM, "new", first);
    s.ada(DM, "handled too", first);
    const late = s.ada(DM, "written while offline", first);

    // The cursor has milliseconds; Slack's microseconds of the handled message are past it, and it is still left out.
    const missed = await s.missed({
      cursors: [
        { channel: DM, at: at(0) },
        { channel: DM, thread: first, at: at(2) },
      ],
    });

    expect(missed.map((c) => [c.thread, texts(c)])).toEqual([[first, ["written while offline"]]]);
    expect(missed[0]!.messages[0]!.id).toBe(late);
  });

  it("takes only mentions in a channel, from trusted people, and no bots, edits or the agent itself", async () => {
    const s = setup();
    s.ada(CHANNEL, `<@${BOT_USER}> please look`);
    s.ada(CHANNEL, "just chatting");
    s.fake.write(CHANNEL, { user: GUEST, text: `<@${BOT_USER}> let me in` });
    s.fake.write(CHANNEL, { user: "U0OTHERBOT", text: `<@${BOT_USER}> beep` });
    s.fake.write(CHANNEL, { user: ADA, text: `<@${BOT_USER}> fixed`, subtype: "message_changed" });
    s.fake.write(CHANNEL, { user: BOT_USER, text: `<@${BOT_USER}> echo` });
    s.fake.write(CHANNEL, { bot_id: "B1", text: `<@${BOT_USER}> app` });
    s.fake.write(CHANNEL, { user: ADA });
    s.ada(CHANNEL, `<@${BOT_USER}> thanks`);

    const missed = await s.missed({ cursors: [{ channel: CHANNEL, at: SINCE }] });
    expect(missed.map((c) => [c.channel, c.direct, texts(c)])).toEqual([
      [CHANNEL, undefined, ["please look", "thanks"]],
    ]);
  });

  it("returns the latest `limit`, and counts what is left out by age or by the cap", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      s.ada(DM, `message ${i}`);
    }

    // A cursor from before the window: two messages are too old, and of the other three the cap keeps two.
    const missed = await s.missed({
      cursors: [{ channel: DM, at: "2025-12-31T00:00:00.000Z" }],
      since: at(2),
      limit: 2,
    });

    expect(missed.map((c) => [texts(c), c.skipped])).toEqual([[["message 3", "message 4"], 3]]);
  });

  it("leaves out a conversation Slack refuses, and reads the others", async () => {
    const s = setup();
    s.fake.refused.add(CHANNEL);
    s.ada(DM, "still here");
    const missed = await s.missed({ cursors: [{ channel: CHANNEL, at: SINCE }] });
    expect(missed.map(texts)).toEqual([["still here"]]);
    expect(s.warnings).toEqual(["could not read a Slack conversation to catch up"]);
  });

  it("reads past the first page of a long thread", async () => {
    const s = setup();
    const parent = s.ada(DM, "start");
    for (let i = 0; i < 205; i++) {
      s.ada(DM, `reply ${i}`, parent);
    }

    const [, thread] = await s.missed({ limit: 1 });
    expect([texts(thread!), thread!.skipped]).toEqual([["reply 204"], 204]);
  });

  it("reads a thread with a cursor though its parent is older than where the conversation left off", async () => {
    const s = setup();
    const known = s.ada(DM, "known");
    s.ada(DM, "old reply", known);
    const quiet = s.ada(DM, "quiet");
    s.ada(DM, "older reply", quiet);
    const cursor = at(3);
    s.ada(DM, "new reply", known);

    const missed = await s.missed({
      cursors: [
        { channel: DM, at: cursor },
        { channel: DM, thread: known, at: cursor },
      ],
    });

    expect(missed.map((c) => [c.thread, texts(c)])).toEqual([[known, ["new reply"]]]);
    expect(s.fake.repliesCalls).toEqual([{ channel: DM, ts: known, oldest: "1767225603.000000" }]);
  });

  it("does not return a message delivered live in this process, nor deliver live one it returned", async () => {
    const s = setup();
    const received: string[] = [];
    await s.chat.start(async (m) => void received.push(m.text));
    await s.fake.directMessage(ADA, "live");
    const ts = s.ada(DM, "written offline");
    // The live one is not in the fake's history; one that is, delivered live first, is not returned.
    await s.fake.emit({
      type: "message",
      channel_type: "im",
      channel: DM,
      user: ADA,
      text: "x",
      ts,
    });

    expect(await s.missed()).toEqual([]);

    const later = s.ada(DM, "returned first");
    expect((await s.missed()).map(texts)).toEqual([["returned first"]]);
    await s.fake.emit({
      type: "message",
      channel_type: "im",
      channel: DM,
      user: ADA,
      text: "y",
      ts: later,
    });

    expect(received).toEqual(["live", "x"]);
  });

  it("opens direct messages only with listed humans named by member id, and skips one Slack will not open", async () => {
    const noHumans = setup(teamWith());
    noHumans.ada(DM, "unlisted");
    expect(await noHumans.missed()).toEqual([]);

    const team = {
      people: [],
      humans: [
        { name: "ada", identities: { chat: ADA } },
        { name: "by name", identities: { chat: "not-a-member-id" } },
        { name: "no chat", identities: {} },
        { name: "closed", identities: { chat: "U0CLOSED01" } },
      ],
    } as unknown as TeamConfig;

    const s = setup(team);
    const open = s.fake.web.conversations.open;
    s.fake.web.conversations.open = async (args) => {
      if (args.users === "U0CLOSED01") {
        throw new Error("cannot_dm_bot");
      }

      return open(args);
    };

    s.ada(DM, "listed");
    expect((await s.missed()).map((c) => c.channel)).toEqual([DM]);
    expect(s.fake.historyCalls.map((c) => c.channel)).toEqual([DM]);
  });

  it("still reads direct messages when Slack does not say who the bot is", async () => {
    const s = setup();
    s.fake.web.auth.test = async () => ({});
    s.ada(DM, "hello");
    expect((await s.missed()).map(texts)).toEqual([["hello"]]);
  });
});

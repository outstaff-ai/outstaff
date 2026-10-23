import { expect, it } from "vitest";
import type { Chat, ChatMessage } from "../ports/index.js";
import type { ChatSeed } from "./seeds.js";
import {
  contractSuite,
  expectPortError,
  requireCapability,
  requireSeed,
  type ContractSetupFn,
} from "./harness.js";

export function chatContract(name: string, setup: ContractSetupFn<Chat, ChatSeed>): void {
  contractSuite(`chat contract: ${name}`, setup, (get) => {
    const channelOf = (t: Parameters<typeof requireSeed>[0], s: ReturnType<typeof get>) => {
      if (!s.seed.channel) {
        t.skip("seed.channel not provided");
      }

      return s.seed.channel!;
    };

    it("delivers inbound messages from trusted people to the handler", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const inbound = requireSeed(t, s.seed, "inbound");
      const received: ChatMessage[] = [];
      await s.subject.start(async (m) => void received.push(m));
      await inbound({
        channel: channelOf(t, s),
        authorId: "U-noor",
        text: "hello team",
        trusted: true,
      });

      expect(received.map((m) => m.text)).toEqual(["hello team"]);
      expect(received[0]?.author.trusted).toBe(true);
      expect(received[0]?.author.bot).toBe(false);
    });

    it("does not deliver messages from untrusted people or bots", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const inbound = requireSeed(t, s.seed, "inbound");
      const received: ChatMessage[] = [];
      await s.subject.start(async (m) => void received.push(m));
      await inbound({
        channel: channelOf(t, s),
        authorId: "U-stranger",
        text: "let me in",
        trusted: false,
      });

      await inbound({ channel: channelOf(t, s), authorId: "B-other", text: "beep", bot: true });
      expect(received).toEqual([]);
    });

    it("stops delivering after stop()", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const inbound = requireSeed(t, s.seed, "inbound");
      const received: ChatMessage[] = [];
      await s.subject.start(async (m) => void received.push(m));
      await s.subject.stop();
      await inbound({ channel: channelOf(t, s), authorId: "U-noor", text: "anyone?" });
      expect(received).toEqual([]);
    });

    it("posts and keeps replies in the same thread", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const channel = channelOf(t, s);
      const first = await s.subject.post(channel, "**hi** there");
      expect(first.id).toBeTruthy();
      expect(first.thread).toBeTruthy();
      const reply = await s.subject.post(channel, "second", { thread: first.thread });
      expect(reply.thread).toBe(first.thread);
    });

    it("posts long text without failing", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const text = Array.from({ length: 2000 }, (_, i) => `line ${i} of a long report`).join("\n");
      await expect(s.subject.post(channelOf(t, s), text)).resolves.toMatchObject({
        id: expect.any(String),
      });
    });

    it("reacts to a posted message and rejects an unknown one", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const channel = channelOf(t, s);
      const posted = await s.subject.post(channel, "work in progress");
      for (const reaction of ["eyes", "done", "error"] as const) {
        await expect(s.subject.react(channel, posted.id, reaction)).resolves.toBeUndefined();
      }

      await expectPortError(s.subject.react(channel, "no-such-message", "eyes"), "not_found");
    });

    it("returns history, newest last and limited", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages", "chat.history");
      const channel = channelOf(t, s);
      const first = await s.subject.post(channel, "one");
      await s.subject.post(channel, "two", { thread: first.thread });
      await s.subject.post(channel, "three", { thread: first.thread });
      const thread = await s.subject.history(channel, { thread: first.thread, limit: 10 });
      expect(thread.map((m) => m.text)).toEqual(["one", "two", "three"]);
      expect(
        (await s.subject.history(channel, { thread: first.thread, limit: 2 })).map((m) => m.text),
      ).toEqual(["two", "three"]);
    });

    it("opens the same direct channel for the same user", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages");
      const userId = s.seed.userId;
      if (!userId) {
        t.skip("seed.userId not provided");
      }

      const a = await s.subject.openDirect(userId!);
      expect(a).toBeTruthy();
      expect(await s.subject.openDirect(userId!)).toBe(a);
    });

    it("publishes an agent profile", async (t) => {
      const s = get();
      requireCapability(t, s, "chat.messages", "chat.agentProfile");
      const userId = s.seed.userId;
      if (!userId) {
        t.skip("seed.userId not provided");
      }

      expect(s.subject.setAgentProfile).toBeTypeOf("function");
      await expect(
        s.subject.setAgentProfile!(userId!, {
          name: "Sam",
          role: "developer",
          status: "working",
          current: { title: "ACME-1 Fix checkout" },
          sections: [{ heading: "Working", lines: ["sam: ACME-1"] }],
        }),
      ).resolves.toBeUndefined();
    });
  });
}

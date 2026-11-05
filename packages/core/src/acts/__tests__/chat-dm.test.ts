import { describe, expect, it } from "vitest";
import { applyActOps } from "#/acts/apply.js";

const noMember = async () => "";

describe("applyActOps: chat_dm", () => {
  it("opens the direct message with the member and posts the body there", async () => {
    const posts: { channel: string; text: string }[] = [];
    const chat = {
      openDirect: async (user: string) => `D-${user}`,
      post: async (channel: string, text: string) => {
        posts.push({ channel, text });
        return { id: "1", thread: "1" };
      },
    };

    expect(
      await applyActOps(
        [{ op: "chat_dm", to: "U0ADA", body: "Ready for review." }],
        { chat },
        noMember,
      ),
    ).toEqual({ ok: true, results: ["sent a direct message to U0ADA"] });

    expect(posts).toEqual([{ channel: "D-U0ADA", text: "Ready for review." }]);
  });

  it("needs a chat, and says which message failed", async () => {
    expect(await applyActOps([{ op: "chat_dm", to: "U0ADA", body: "x" }], {}, noMember)).toEqual({
      ok: false,
      results: [],
      error: "chat_dm U0ADA: no chat is configured",
    });
  });
});

describe("applyActOps: chat_reply", () => {
  it("posts the body as a reply in the thread", async () => {
    const posts: { channel: string; text: string; thread?: string | undefined }[] = [];
    const chat = {
      openDirect: async (user: string) => `D-${user}`,
      post: async (channel: string, text: string, opts?: { thread?: string }) => {
        posts.push({ channel, text, thread: opts?.thread });
        return { id: "2", thread: opts?.thread ?? "2" };
      },
    };

    const reply = { op: "chat_reply" as const, channel: "D-sam", thread: "1700.1", body: "Ready." };
    expect(await applyActOps([reply], { chat }, noMember)).toEqual({
      ok: true,
      results: ["replied in chat thread D-sam:1700.1"],
    });

    expect(posts).toEqual([{ channel: "D-sam", text: "Ready.", thread: "1700.1" }]);
    expect(await applyActOps([reply], {}, noMember)).toEqual({
      ok: false,
      results: [],
      error: "chat_reply D-sam:1700.1: no chat is configured",
    });
  });
});

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

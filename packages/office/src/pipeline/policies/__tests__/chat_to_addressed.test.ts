import { describe, expect, it } from "vitest";
import { ADA, SAM, judge, event } from "./support.js";

describe("chat_to_addressed", () => {
  it("a human's message wakes the agent it is written to", () => {
    const msg = (actor = ADA) =>
      event("chat.message", {
        subject: { chat: { channel: "D0SAM" } },
        actor,
        data: { addressed: "sam", body: "hi" },
      });

    expect(judge("chat_to_addressed", msg())).toEqual(["wake sam (chat) on chat D0SAM"]);

    expect(judge("chat_to_addressed", msg(SAM))).toEqual({ failed: { actor_kind: "human" } });
  });
});

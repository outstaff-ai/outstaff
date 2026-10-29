import { describe, expect, it } from "vitest";
import { chatConversation, chatEvent, chatEventId, withFiles } from "#/chat/event.js";

const m = {
  messageId: "1700.1",
  channel: "C-1",
  text: "Can you look at ACME-41?",
  author: { id: "U-SAM", name: "Sam" },
  direct: false,
  participant: true,
};

describe("chat events", () => {
  it("puts a reply in its thread, a top-level mention in its own, and a direct message's top level in one conversation", () => {
    expect(chatConversation({ ...m, thread: "1600.1" })).toEqual({
      channel: "C-1",
      thread: "1600.1",
    });

    expect(chatConversation(m)).toEqual({ channel: "C-1", thread: "1700.1" });
    expect(chatConversation({ ...m, direct: true })).toEqual({ channel: "C-1" });
    expect(chatConversation({ ...m, direct: true, thread: "1600.1" })).toEqual({
      channel: "C-1",
      thread: "1600.1",
    });
  });

  it("makes a message to an agent a chat.message from its human author, addressed to the agent", () => {
    expect(chatEvent("kofi", m, "2030-01-01T00:00:00.000Z")).toEqual({
      event: {
        type: "chat.message",
        subject: { chat: { channel: "C-1", thread: "1700.1" } },
        actor: { kind: "human", id: "U-SAM" },
        data: { body: m.text, addressed: "kofi", at: "2030-01-01T00:00:00.000Z", message: m },
      },
      meta: { source: "chat", externalId: "kofi:C-1:1700.1", trusted: true },
    });

    expect(chatEventId("mira", m)).toBe("mira:C-1:1700.1");
  });

  it("names the files a message shares", () => {
    const files = [{ id: "F1", name: "log.txt", mimetype: "text/plain", size: 3, url: "x" }];
    expect(withFiles({ text: "", files })).toBe("(Shared log.txt (text/plain).)");
    expect(withFiles({ text: "see", files: [] })).toBe("see");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { readOrigin } from "#/chat/origin.js";
import { chatTitle, joinChatSession, messageOf, openChatSession } from "#/chat/session.js";
import { openStore, type Store } from "#/store/index.js";

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

const m = {
  messageId: "1700.1",
  channel: "D-1",
  text: "Can you look at ACME-41?",
  author: { id: "U-SAM" },
  direct: true,
  participant: true,
};

const files = [{ id: "F1", name: "log.txt", mimetype: "text/plain", size: 3, url: "x" }];

async function item() {
  store = await openStore("sqlite::memory:");
  await store.upsertSubject("ticket", "ACME-41", { title: "Coupon" });
  return store.enqueue({ person: "kofi", kind: "chat", title: "t", trigger: "human" });
}

describe("chat sessions the pipeline queues", () => {
  it("reads the message a chat.message carries, and nothing else", () => {
    expect(messageOf({ message: m })).toBe(m);
    expect(messageOf({})).toBeUndefined();
    expect(messageOf({ message: { channel: "D-1" } })).toBeUndefined();
  });

  it("titles a session by the message's first line, else its file", () => {
    expect(chatTitle({ text: "Fix it\nplease" })).toBe("Chat: Fix it");
    expect(chatTitle({ text: "x".repeat(100) })).toBe(`Chat: ${"x".repeat(79)}…`);
    expect(chatTitle({ text: "", files })).toBe("Chat: log.txt");
    expect(chatTitle({ text: " " })).toBe("Chat: (no text)");
  });

  it("gives the item the thread to answer in, the requester, and the message and tickets as its trigger", async () => {
    const i = await item();
    await openChatSession(store!, i.id, { ...m, files });
    expect(await readOrigin(store!, i.id)).toEqual({
      channel: "D-1",
      thread: "1700.1",
      requester: { id: "U-SAM" },
      direct: true,
      participant: true,
      awaitingPlacement: false,
      claimed: [],
      text: m.text,
      files,
    });

    expect((await store!.getSubject("chat_thread", "D-1:1700.1"))?.data).toEqual({ itemId: i.id });
    expect(
      (await store!.listItemRefs(i.id)).map((r) => [r.type, r.ref, r.role]).toSorted(),
    ).toEqual([
      ["chat_message", "D-1:1700.1", "trigger"],
      ["chat_thread", "D-1:1700.1", "trigger"],
      ["ticket", "ACME-41", "mentioned"],
    ]);
  });

  it("answers in the thread of a reply, names the requester, and adds a later message as attached", async () => {
    const i = await item();
    await openChatSession(store!, i.id, {
      ...m,
      thread: "1600.1",
      author: { id: "U-SAM", name: "Sam" },
    });

    expect(await readOrigin(store!, i.id)).toMatchObject({
      thread: "1600.1",
      requester: { id: "U-SAM", name: "Sam" },
    });

    await joinChatSession(store!, i.id, { ...m, messageId: "1700.2", text: "and ACME-41 too" });
    expect(
      (await store!.listItemRefs(i.id))
        .filter((r) => r.ref === "D-1:1700.2")
        .map((r) => [r.type, r.role])
        .toSorted(),
    ).toEqual([
      ["chat_message", "attached"],
      ["chat_thread", "attached"],
    ]);
  });
});

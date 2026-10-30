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
    await openChatSession(store!, i, { ...m, files });
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
    await openChatSession(store!, i, {
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

  it("tells a reply in the thread of running work which item it is about, and leaves the thread with that work", async () => {
    const session = await item();
    const work = await store!.enqueue({
      person: "kofi",
      kind: "review_feedback",
      title: "review feedback: PR #4",
      trigger: "human",
    });

    await store!.addItemRefs(work.id, [
      { type: "pr", ref: "acme/app#4", role: "subject", source: "s" },
      { type: "chat_thread", ref: "D-1:1600.1", role: "trigger", source: "s" },
    ]);

    await store!.upsertSubject("chat_thread", "D-1:1600.1", { itemId: work.id });
    await openChatSession(store!, session, { ...m, thread: "1600.1" });
    expect((await readOrigin(store!, session.id))?.about).toEqual({
      id: work.id,
      title: "review feedback: PR #4",
      state: "running",
    });

    expect((await store!.getSubject("chat_thread", "D-1:1600.1"))?.data).toEqual({
      itemId: work.id,
    });

    expect(
      (await store!.listItemRefs(session.id)).filter((r) => r.type === "pr").map((r) => r.role),
    ).toEqual(["inferred"]);

    // Finished, the work leaves the thread to the session that answers in it.
    await store!.updateItem(work.id, { status: "done" });
    const next = await store!.enqueue({
      person: "kofi",
      kind: "chat",
      title: "t",
      trigger: "human",
    });

    await openChatSession(store!, next, { ...m, messageId: "1700.3", thread: "1600.1" });
    expect((await readOrigin(store!, next.id))?.about?.state).toBe("finished");
    expect((await store!.getSubject("chat_thread", "D-1:1600.1"))?.data).toEqual({
      itemId: next.id,
    });
  });

  it("goes on with the conversation of the session that answered in the thread before, but not someone else's", async () => {
    const first = await item();
    await store!.updateItem(first.id, { sessionId: "s-1", status: "done" });
    await openChatSession(store!, first, m);
    const second = await store!.enqueue({
      person: "kofi",
      kind: "chat",
      title: "t",
      trigger: "human",
    });

    await openChatSession(store!, second, { ...m, messageId: "1700.2", thread: "1700.1" });
    expect((await store!.getItem(second.id))?.sessionId).toBe("s-1");
    expect((await readOrigin(store!, second.id))?.about).toBeUndefined();

    const other = await store!.enqueue({
      person: "pia",
      kind: "chat",
      title: "t",
      trigger: "human",
    });

    await openChatSession(store!, other, { ...m, messageId: "1700.4", thread: "1700.1" });
    expect((await store!.getItem(other.id))?.sessionId ?? null).toBeNull();
  });
});

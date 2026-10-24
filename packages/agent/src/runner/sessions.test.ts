import { describe, expect, it } from "vitest";
import type { Offer } from "../office-client/index.js";
import { createSessionManager, sessionKey } from "./sessions.js";

const offer = (id: string, extra: { sessionId?: string; thread?: string } = {}): Offer => ({
  workItem: {
    id,
    kind: extra.thread ? "chat" : "ticket",
    title: id,
    priority: 1,
    trigger: "human",
    ...(extra.thread
      ? { origin: { channel: "D1", thread: extra.thread, requester: { id: "U0REQ0001" } } }
      : {}),
  },
  context: { journal: [], subjects: [], links: [] },
  ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
});

function setup() {
  const stored: [string, string][] = [];
  const manager = createSessionManager({
    async session(id, sessionId) {
      stored.push([id, sessionId]);
    },
  });

  return { manager, stored };
}

describe("sessions", () => {
  it("keys chat requests by thread and everything else by item", () => {
    expect(sessionKey(offer("w1"))).toBe("item:w1");
    expect(sessionKey(offer("c1", { thread: "t1" }))).toBe("thread:D1:t1");
  });

  it("resumes what the office stored with the item and stores a new session once", async () => {
    const { manager, stored } = setup();
    expect(manager.resumeFor(offer("w1"))).toBeUndefined();
    await manager.started("w1", "s1");
    await manager.started("w1", "s1");
    expect(stored).toEqual([["w1", "s1"]]);
    expect(manager.resumeFor(offer("w1", { sessionId: "s1" }))).toBe("s1");
  });

  it("never gives an item the session of another item", async () => {
    const { manager } = setup();
    manager.resumeFor(offer("w1"));
    await manager.started("w1", "s1");
    expect(manager.resumeFor(offer("w2"))).toBeUndefined();
  });

  it("continues a chat thread's session in a later item of the thread, not in other threads or items", async () => {
    const { manager, stored } = setup();
    expect(manager.resumeFor(offer("c1", { thread: "t1" }))).toBeUndefined();
    await manager.started("c1", "chat-s1");

    // The follow-up item of the thread arrives without a stored session.
    expect(manager.resumeFor(offer("c2", { thread: "t1" }))).toBe("chat-s1");
    expect(manager.resumeFor(offer("c3", { thread: "t2" }))).toBeUndefined();
    expect(manager.resumeFor(offer("w1"))).toBeUndefined();

    // Its session is already known, so it is not stored again.
    await manager.started("c2", "chat-s1");
    expect(stored).toEqual([["c1", "chat-s1"]]);
  });

  it("gives work that a chat session filed a session of its own", async () => {
    const { manager } = setup();
    const filed = (id: string): Offer => ({
      ...offer(id, { thread: "t1" }),
      workItem: { ...offer(id, { thread: "t1" }).workItem, kind: "assigned" },
    });

    expect(sessionKey(filed("w1"))).toBe("item:w1");
    manager.resumeFor(offer("c1", { thread: "t1" }));
    await manager.started("c1", "chat-s1");
    expect(manager.resumeFor(filed("w1"))).toBeUndefined();
  });

  it("does not use a work item's session for a chat thread", async () => {
    const { manager } = setup();
    manager.resumeFor(offer("w1"));
    await manager.started("w1", "item-s");
    expect(manager.resumeFor(offer("c1", { thread: "w1" }))).toBeUndefined();
  });
});

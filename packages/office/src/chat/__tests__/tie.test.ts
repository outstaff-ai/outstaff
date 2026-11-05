import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_ORIGIN_SUBJECT } from "#/chat/origin.js";
import { chatThreadsOf } from "#/chat/tie.js";
import { openStore, type Store } from "#/store/index.js";
import type { WorkState } from "#/workstate/index.js";

/** The ticket ACME-1 has one pull request, which the work state keys as `pr:9`. */
const workState = {
  prsOfTicket: (key: string) => (key === "ACME-1" ? [{ ref: { number: 9 } }] : []),
  prSubject: (ref: { number: number }) => `pr:${ref.number}`,
} as unknown as Pick<WorkState, "prsOfTicket" | "prSubject">;

describe("the chat threads a ticket's work is tied to", () => {
  let store: Store;

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  const item = (o: {
    person?: string;
    kind?: string;
    subject: { type: string; ref: string };
    parentId?: string;
    mentions?: string;
  }) =>
    store.enqueue({
      person: o.person ?? "sam",
      kind: o.kind ?? "assigned",
      title: "t",
      trigger: "human",
      subject: o.subject,
      ...(o.parentId ? { parentId: o.parentId } : {}),
      ...(o.mentions
        ? { refs: [{ type: "ticket", ref: o.mentions, role: "mentioned", source: "chat" }] }
        : {}),
    });

  const fromChat = (id: string, thread: string, requester = "U0ADA") =>
    store.upsertSubject(CHAT_ORIGIN_SUBJECT, id, {
      channel: "D-sam",
      thread,
      requester: { id: requester },
      claimed: [],
    });

  it("finds the thread of the chat session that filed the work, from a later round on its pull request", async () => {
    const session = await item({ kind: "chat", subject: { type: "chat", ref: "D-sam:T1" } });
    await fromChat(session.id, "T1");
    // The filed work has no origin of its own here: its parent's thread ties it.
    await item({ subject: { type: "ticket", ref: "ACME-1" }, parentId: session.id });
    const merge = await item({ kind: "merge", subject: { type: "pr", ref: "pr:9" } });
    const threads = await chatThreadsOf(store, workState, "sam", "ACME-1", [merge.id]);
    expect(threads).toMatchObject([{ channel: "D-sam", thread: "T1", requester: { id: "U0ADA" } }]);
  });

  it("is tied by no thread that only mentioned the ticket, nor by another agent's", async () => {
    const asked = await item({
      kind: "chat",
      subject: { type: "chat", ref: "D-sam:T2" },
      mentions: "ACME-1",
    });

    await fromChat(asked.id, "T2");
    const theirs = await item({ person: "pia", subject: { type: "ticket", ref: "ACME-1" } });
    await fromChat(theirs.id, "T3");
    await item({ subject: { type: "ticket", ref: "ACME-1" } });
    expect(await chatThreadsOf(store, workState, "sam", "ACME-1")).toEqual([]);
  });
});

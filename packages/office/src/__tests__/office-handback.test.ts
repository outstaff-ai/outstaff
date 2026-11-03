import { silentLogger, type WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_ORIGIN_SUBJECT } from "#/chat/origin.js";
import { createHandedBack } from "#/office-handback.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/types.js";

describe("the hand-back of an item", () => {
  let store: Store;
  let judged: WorkflowEvent[];

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    judged = [];
  });

  afterEach(async () => {
    await store.close();
  });

  const handedBack = () =>
    createHandedBack({
      store,
      workState: {
        refreshWorkers: async () => {},
        refreshTicket: async () => {},
      } as unknown as WorkState,
      judge: async (event) => void judged.push(event),
      log: silentLogger,
    });

  const done = async () => {
    const w = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    return store.updateItem(w.id, { status: "done" });
  };

  const base = (workItem: string) => ({
    workItem,
    kind: "assigned",
    status: "done",
    summary: "Built it.",
    created: [],
    opened: [],
  });

  it("says when the work came from a chat thread, which gets its result", async () => {
    const plain = await done();
    await handedBack()(plain, { summary: "Built it.", status: "done" });
    const fromChat = await done();
    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, fromChat.id, { channel: "C1", claimed: [] });
    await handedBack()(fromChat, { summary: "Built it.", status: "done" });
    expect(judged.map((e) => e.data)).toEqual([
      { ...base(plain.id) },
      { ...base(fromChat.id), chat: true },
    ]);
  });
});

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
        refreshPrsOf: async () => {},
      } as unknown as WorkState,
      judge: async (event) => void judged.push(event),
      log: silentLogger,
    });

  const done = async (o: { subject?: { type: string; ref: string }; kind?: string } = {}) => {
    const w = await store.enqueue({
      person: "sam",
      kind: o.kind ?? "assigned",
      title: "t",
      trigger: "human",
      subject: o.subject ?? { type: "ticket", ref: "ACME-1" },
    });

    return store.updateItem(w.id, { status: "done" });
  };

  const base = (workItem: string, kind = "assigned") => ({
    workItem,
    kind,
    status: "done",
    summary: "Built it.",
    created: [],
    opened: [],
  });

  const fromChat = (id: string, requester: string) =>
    store.upsertSubject(CHAT_ORIGIN_SUBJECT, id, {
      channel: "C1",
      thread: "T1",
      requester: { id: requester },
      claimed: [],
    });

  it("names the chat members of the threads the round's own result goes to", async () => {
    const plain = await done();
    await handedBack()(plain, { summary: "Built it.", status: "done" });
    const filed = await done();
    await fromChat(filed.id, "U0ADA");
    await handedBack()(filed, { summary: "Built it.", status: "done" });
    expect(judged.map((e) => e.data)).toEqual([
      { ...base(plain.id) },
      { ...base(filed.id), chat: ["U0ADA"] },
    ]);
  });

  it("gives a later round the ticket as the round found it and the last notice about it", async () => {
    await store.upsertSubject("pr", "pr:9", { ref: { number: 9 }, ticket: "ACME-1" });
    const merge = await done({ kind: "merge", subject: { type: "pr", ref: "pr:9" } });
    await store.upsertSubject("round_start", merge.id, {
      ticket: "ACME-1",
      status: "review",
      assignee: { id: "ada.admin", kind: "human" },
    });

    await store.upsertSubject("handoff_notified", "ACME-1", { human: "ada.admin", prs: {} });
    await handedBack()(merge, { summary: "Built it.", status: "done" });
    expect(judged.at(-1)?.data).toEqual({
      ...base(merge.id, "merge"),
      before: { status: "review", assignee: { id: "ada.admin", kind: "human" } },
      notified: { human: "ada.admin", prs: {} },
    });
  });
});

import { PortError } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendChatLog } from "#/chat/log.js";
import { chatThreadRef, mentionedRefs, triggerRefs } from "#/refs/index.js";
import { openStore, type Store } from "#/store/index.js";
import type { DocRecord, PrRecord, TicketRecord } from "#/workstate/index.js";
import { inferTicketRefs } from "#/workstate/item-refs.js";
import { gatherGraph, wakeContextOf } from "#/wake-context/index.js";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };

const prRecord = (number: number, over: Partial<PrRecord> = {}): PrRecord => ({
  ref: { repo: REPO, number },
  title: `PR ${number}`,
  url: `https://git.acme.example/acme/app/pull/${number}`,
  headRef: `b${number}`,
  headSha: "sha",
  baseRef: "main",
  draft: false,
  state: "open",
  mergeable: "clean",
  author: { login: "acme-kofi[bot]", kind: "agent", person: "kofi" },
  checks: [],
  ci: "none",
  unresolvedThreads: 2,
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const ticketRecord = (key: string): TicketRecord => ({
  key,
  title: `Ticket ${key}`,
  url: `https://track.acme.example/${key}`,
  status: "active",
  labels: [],
  updatedAt: "2026-10-01T09:00:00.000Z",
});

describe("gathering what the office knows around an item", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  const item = (refs: Parameters<Store["enqueue"]>[0]["refs"] = []) =>
    store.enqueue({ person: "kofi", kind: "assigned", title: "t", trigger: "human", refs });

  it("follows a document to its ticket, a ticket to its PRs, and a PR to its stack, with what the office has", async () => {
    await store.upsertSubject("doc", "doc-1", {
      id: "doc-1",
      title: "Design",
      url: "https://kb.acme.example/doc-1",
      author: "kofi",
      ticket: "ACME-1",
      touchedAt: "2026-10-01T09:00:00.000Z",
    } satisfies DocRecord);

    await store.upsertSubject("ticket", "ACME-1", ticketRecord("ACME-1"));
    await store.upsertSubject(
      "pr",
      "acme/app#2",
      prRecord(2, { ticket: "ACME-1", stackedOn: "acme/app#1" }),
    );

    await store.upsertSubject("pr", "acme/app#1", prRecord(1, { state: "merged" }));
    await store.upsertSubject("pr", "acme/app#3", prRecord(3));
    await store.link(
      { type: "pr", ref: "acme/app#2" },
      { type: "ticket", ref: "ACME-1" },
      "implements",
    );

    await store.link(
      { type: "pr", ref: "acme/app#3" },
      { type: "pr", ref: "acme/app#2" },
      "stacked_on",
    );

    const it1 = await item([{ type: "doc", ref: "doc-1", role: "created", source: "doc_link" }]);
    const failing = {
      getIssue: async () => {
        throw new PortError("unavailable", "down");
      },
      listComments: async () => [],
    };

    const vcs = {
      reviewThreads: async () => {
        throw new PortError("unavailable", "down");
      },
      links: { thread: () => "", pr: () => "", commit: () => "" },
      checks: async () => [],
    };

    const graph = await gatherGraph({ store, tracker: failing, vcs }, it1.id, 16);
    expect(graph.docs.map((d) => d.ticket)).toEqual(["ACME-1"]);
    expect(graph.tickets).toEqual([
      {
        key: "ACME-1",
        title: "Ticket ACME-1",
        url: "https://track.acme.example/ACME-1",
        status: "active",
        assignee: undefined,
        description: undefined,
        comments: [],
      },
    ]);

    expect(graph.prs.map((p) => [p.ref, p.unresolvedThreads, p.threads.length]).toSorted()).toEqual(
      [
        ["acme/app#1", 2, 0],
        ["acme/app#2", 2, 0],
        ["acme/app#3", 2, 0],
      ],
    );
  });

  it("leaves out what it cannot find, and a chat thread with no messages", async () => {
    const it1 = await item([
      { type: "ticket", ref: "ACME-404", role: "subject", source: "office" },
      { type: "pr", ref: "acme/app#404", role: "inferred", source: "workstate:implements" },
      { type: "doc", ref: "doc-404", role: "created", source: "doc_link" },
      { type: "chat_thread", ref: "C1:1", role: "trigger", source: "chat:C1:1" },
      { type: "chat_thread", ref: "nocolon", role: "trigger", source: "chat:x" },
    ]);

    await appendChatLog(store, "nocolon", {
      messageId: "1",
      author: { id: "U1" },
      at: "2026-10-01T09:00:00.000Z",
      text: "hi",
    });

    const graph = await gatherGraph({ store }, it1.id, 16);
    expect([graph.tickets, graph.prs, graph.docs, graph.chats]).toEqual([[], [], [], []]);
  });

  it("finds the chat thread other work on the same ticket came from", async () => {
    await store.upsertSubject("ticket", "ACME-1", ticketRecord("ACME-1"));
    const filed = await store.enqueue({
      person: "kofi",
      kind: "assigned",
      title: "t",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
      refs: [
        {
          type: "chat_thread",
          ref: chatThreadRef("D1", "1"),
          role: "trigger",
          source: "work_link",
        },
      ],
    });

    await appendChatLog(store, "D1:1", {
      messageId: "1",
      author: { id: "U1", name: "Sam" },
      at: "2026-10-01T09:00:00.000Z",
      text: "please fix",
    });

    // The same message delivered twice is kept once.
    await appendChatLog(store, "D1:1", {
      messageId: "1",
      author: { id: "U1" },
      at: "2026-10-01T09:00:00.000Z",
      text: "please fix",
    });

    await appendChatLog(store, "D1:1", {
      messageId: "2",
      author: { id: "U2" },
      at: "2026-10-01T09:01:00.000Z",
      text: "same here",
    });

    const later = await item([
      { type: "ticket", ref: "ACME-1", role: "trigger", source: "tracker:9" },
    ]);

    const graph = await gatherGraph({ store }, later.id, 16);
    expect(graph.related).toEqual([
      { via: { type: "ticket", ref: "ACME-1" }, chat: "D1:1", itemId: filed.id },
    ]);

    expect(graph.chats[0]!.messages).toEqual([
      { author: "Sam", at: "2026-10-01T09:00:00.000Z", text: "please fix" },
      { author: "U2", at: "2026-10-01T09:01:00.000Z", text: "same here" },
    ]);

    // A wake with nothing linked carries no bundle; a failing read sends the offer without one.
    const wakeOf = wakeContextOf({ store }, { limits: DEFAULT_CONTEXT_LIMITS });
    expect(await wakeOf(await item(), true)).toBeUndefined();
    const warned: string[] = [];
    const broken = wakeContextOf(
      { store: { ...store, listItemRefs: () => Promise.reject(new Error("gone")) } },
      { limits: DEFAULT_CONTEXT_LIMITS, logger: { warn: (m) => void warned.push(m) } },
    );

    expect(await broken(later, true)).toBeUndefined();
    expect(warned).toEqual(["could not build the context of a wake"]);
  });

  it("names the refs of an event, and only the tickets the office knows", async () => {
    expect(
      triggerRefs(
        {
          pr: { repo: REPO, number: 4 },
          ticket: "ACME-1",
          doc: "d",
          chat: { channel: "C", thread: "9" },
        },
        "vcs:1",
        (pr) => `acme/app#${pr.number}`,
      ).map((r) => [r.type, r.ref]),
    ).toEqual([
      ["pr", "acme/app#4"],
      ["ticket", "ACME-1"],
      ["doc", "d"],
      ["chat_thread", "C:9"],
    ]);

    expect(triggerRefs({ chat: { channel: "C" } }, "chat:1", () => "")).toEqual([]);
    const refs = await mentionedRefs(
      "See acme-1, UTF-8 and ACME-1 again",
      "chat:1",
      (k) => k === "ACME-1",
    );

    expect(refs).toEqual([{ type: "ticket", ref: "ACME-1", role: "mentioned", source: "chat:1" }]);
  });

  it("infers nothing for a PR without a ticket", async () => {
    const it1 = await item([{ type: "pr", ref: "acme/app#1", role: "subject", source: "office" }]);
    await inferTicketRefs(store, "acme/app#1", prRecord(1));
    expect(await store.listItemRefs(it1.id)).toHaveLength(1);
  });
});

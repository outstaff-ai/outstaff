import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendChatLog } from "#/chat/log.js";
import { openChatSession } from "#/chat/session.js";
import type { PrLookup } from "#/chat/types.js";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";
import { wakeContextOf } from "#/wake-context/index.js";
import type { PrRecord, TicketRecord } from "#/workstate/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const key = (n: number) => `acme/app#${n}`;

const pr = (number: number, author: PrRecord["author"], ticket?: string): PrRecord => ({
  ref: { repo: REPO, number },
  title: `PR ${number}`,
  url: `https://git.acme.example/acme/app/pull/${number}`,
  headRef: `b${number}`,
  headSha: "sha",
  baseRef: "main",
  draft: false,
  state: "open",
  mergeable: "clean",
  author,
  checks: [{ name: "test", status: "failure" }],
  ci: "failure",
  unresolvedThreads: 0,
  ...(ticket ? { ticket } : {}),
  updatedAt: "2026-10-01T09:00:00.000Z",
});

const ticket = (k: string, assignee?: TicketRecord["assignee"]): TicketRecord => ({
  key: k,
  title: `Ticket ${k}`,
  status: "review",
  labels: [],
  ...(assignee ? { assignee } : {}),
  updatedAt: "2026-10-01T09:00:00.000Z",
});

const KOFI = { login: "acme-kofi[bot]", kind: "agent" as const, person: "kofi" };
const DANA = { login: "dana", kind: "human" as const };

describe("a chat wake says which of the work it names is the agent's", () => {
  let store: Store;
  const records = new Map<string, PrRecord>();
  const prs: PrLookup = {
    pullRequests: (n) => [...records.values()].filter((p) => p.ref.number === n),
    prSubject: (ref) => key(ref.number),
  };

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    const seed: [number, PrRecord][] = [
      [57, pr(57, KOFI, "ACME-75")],
      [60, pr(60, DANA, "ACME-80")],
      [61, pr(61, DANA, "ACME-81")],
    ];

    for (const [n, rec] of seed) {
      records.set(key(n), rec);
      await store.upsertSubject("pr", key(n), rec);
      await store.link(
        { type: "pr", ref: key(n) },
        { type: "ticket", ref: rec.ticket! },
        "implements",
      );
    }

    await store.upsertSubject("ticket", "ACME-75", ticket("ACME-75", { id: "ada", kind: "human" }));
    await store.upsertSubject(
      "ticket",
      "ACME-76",
      ticket("ACME-76", { id: "kofi", kind: "agent" }),
    );

    await store.upsertSubject("ticket", "ACME-80", ticket("ACME-80", { id: "pia", kind: "agent" }));
    await store.upsertSubject("ticket", "ACME-81", ticket("ACME-81", { id: "ada", kind: "human" }));
  });

  afterEach(async () => {
    await store.close();
    records.clear();
  });

  /** A chat session for kofi on the message, and the bundle its wake carries. */
  async function wake(text: string, lastWorker: Record<string, string> = {}) {
    const item = await store.enqueue({
      person: "kofi",
      kind: "chat",
      title: "t",
      trigger: "human",
    });

    const m = {
      messageId: "1700.1",
      channel: "D-1",
      text,
      author: { id: "U-ADA" },
      direct: true,
      participant: true,
    };

    await appendChatLog(store, "D-1:1700.1", {
      messageId: m.messageId,
      author: m.author,
      at: "t",
      text,
    });

    await openChatSession(store, item, m, prs);
    const wakeOf = wakeContextOf(
      { store, lastWorker: (k) => lastWorker[k] },
      { limits: { ...DEFAULT_CONTEXT_LIMITS, items: 20 } },
    );

    const context = (await wakeOf(item, true))!;
    return {
      prs: context.prs.map((p) => [p.ref, p.author, p.yours ?? false, p.ci, p.why.role]),
      tickets: context.tickets.map((t) => [t.key, t.yours ?? false, t.why.role]),
    };
  }

  it("marks the agent's own pull request by its link, with its CI, and the ticket it implements", async () => {
    // The ticket was handed back to the human, but the agent opened the pull request.
    const got = await wake("CI still fails on https://git.acme.example/acme/app/pull/57");
    expect(got.prs).toEqual([[key(57), "kofi", true, "failure", "mentioned"]]);
    expect(got.tickets).toEqual([["ACME-75", false, "linked"]]);
  });

  it("marks a ticket assigned to the agent, and one it last worked on, with that ticket's pull request", async () => {
    const got = await wake("Is ACME-76 done? And ACME-81?", { "ACME-81": "kofi" });
    expect(got.tickets).toEqual([
      ["ACME-76", true, "mentioned"],
      ["ACME-81", true, "mentioned"],
    ]);

    // A human opened it, but it implements the agent's ticket.
    expect(got.prs).toEqual([[key(61), "dana", true, "failure", "linked"]]);
  });

  it("names someone else's pull request and ticket with their author and assignee, not as the agent's", async () => {
    const got = await wake("Is PR 60 blocked?");
    expect(got.prs).toEqual([[key(60), "dana", false, "failure", "mentioned"]]);
    expect(got.tickets).toEqual([["ACME-80", false, "linked"]]);
  });

  it("adds nothing for a reference the office does not know", async () => {
    const got = await wake("What about #99, acme/app#98 and ACME-999?");
    expect(got).toEqual({ prs: [], tickets: [] });
  });
});

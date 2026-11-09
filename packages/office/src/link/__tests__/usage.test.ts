import { silentLogger } from "@outstaff/core";
import type { TicketUsage } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { findItem } from "#/link/item.js";
import { findItems } from "#/link/items.js";
import type { OfficeLinkOptions } from "#/link/link.types.js";
import { answer } from "#/link/requests.js";
import { openStore, type Store } from "#/store/index.js";

const counts = (n: number, costUsd: number | null) => ({
  inputTokens: n,
  outputTokens: n,
  cacheReadTokens: n,
  cacheCreationTokens: n,
  costUsd,
});

describe("usage over the office link", () => {
  let store: Store;
  const clock = manualClock("2026-10-05T10:00:00.000Z");
  const opts = (usage?: OfficeLinkOptions["usage"]) =>
    ({
      store,
      clock,
      logger: silentLogger,
      ...(usage ? { usage } : {}),
    }) as unknown as OfficeLinkOptions;

  beforeEach(async () => {
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  /** A finished run of sam's on an item with the subject, which used `n` of each token. */
  async function ran(n: number, subject?: { type: string; ref: string }) {
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
      ...(subject ? { subject } : {}),
    });

    const run = await store.startRun(item.id);
    await store.recordRunUsage(run.id, `s-${item.id}`, [
      { model: "claude-opus-5-5", ...counts(n, n / 100) },
      { model: "claude-haiku-5-5", ...counts(1, null) },
    ]);

    await store.finishRun(run.id, { outcome: "done" });
    return item;
  }

  it("refuses both methods when the team does not track usage", async () => {
    for (const r of [
      { id: "u", method: "usage" as const },
      { id: "t", method: "ticket_usage" as const, params: { ticket: "ACME-1" } },
    ]) {
      expect(await answer(opts(), r)).toEqual({
        id: r.id,
        error: { code: "invalid", message: "This team does not track usage (usage.track_cost)." },
      });
    }
  });

  it("gives each person's usage, with the part that names no ticket, and each day's", async () => {
    await ran(10, { type: "ticket", ref: "ACME-1" });
    await ran(20);
    const res = await answer(opts({ ticket: async () => ({}) as TicketUsage }), {
      id: "u",
      method: "usage",
    });

    expect(res).toMatchObject({
      id: "u",
      result: {
        since: null,
        until: "2026-10-05T10:00:00.000Z",
        byPerson: [
          {
            person: "sam",
            totals: { tokens: 128, runs: 2, costUsd: expect.closeTo(0.3) },
            unattributed: { tokens: 84, runs: 1, costUsd: 0.2 },
          },
        ],
        byDay: [{ day: "2026-10-05", totals: { tokens: 128 } }],
      },
    });

    const later = await answer(opts({ ticket: async () => ({}) as TicketUsage }), {
      id: "w",
      method: "usage",
      params: { since: "2026-10-06T00:00:00.000Z", until: "2026-10-07T00:00:00.000Z" },
    });

    expect(later).toMatchObject({ result: { byPerson: [], byDay: [] } });
  });

  it("gives a ticket's usage as the office computes it", async () => {
    const usage = { ticket: "ACME-1" } as TicketUsage;
    expect(
      await answer(opts({ ticket: async () => usage }), {
        id: "t",
        method: "ticket_usage",
        params: { ticket: "ACME-1" },
      }),
    ).toEqual({ id: "t", result: usage });
  });

  it("puts each run's usage on the item, null for a run without", async () => {
    const item = await ran(10, { type: "ticket", ref: "ACME-1" });
    await store.startRun(item.id);
    const found = (await findItem(store, item.id))!;
    expect(found.item.runs.map((r) => r.usage)).toEqual([
      {
        totals: {
          inputTokens: 11,
          outputTokens: 11,
          cacheReadTokens: 11,
          cacheCreationTokens: 11,
          tokens: 44,
          costUsd: 0.1,
          runs: 1,
        },
        models: [
          { model: "claude-opus-5-5", totals: expect.objectContaining({ tokens: 40 }) },
          { model: "claude-haiku-5-5", totals: expect.objectContaining({ tokens: 4 }) },
        ],
      },
      null,
    ]);

    const empty = await store.enqueue({ person: "sam", kind: "k", title: "t", trigger: "human" });
    expect((await findItem(store, empty.id))!.item.runs).toEqual([]);
  });

  it("adds up the item's runs that reported usage, on the item and in the list", async () => {
    const item = await ran(10, { type: "ticket", ref: "ACME-1" });
    const again = await store.startRun(item.id);
    await store.recordRunUsage(again.id, "s-again", [
      { model: "claude-opus-5-5", ...counts(5, 0.05) },
    ]);

    await store.finishRun(again.id, { outcome: "done" });
    await store.startRun(item.id);

    const usage = {
      totals: {
        inputTokens: 16,
        outputTokens: 16,
        cacheReadTokens: 16,
        cacheCreationTokens: 16,
        tokens: 64,
        costUsd: expect.closeTo(0.15),
        runs: 2,
      },
      models: [
        {
          model: "claude-opus-5-5",
          totals: expect.objectContaining({ tokens: 60, runs: 2, costUsd: expect.closeTo(0.15) }),
        },
        { model: "claude-haiku-5-5", totals: expect.objectContaining({ tokens: 4, runs: 1 }) },
      ],
    };

    const found = (await findItem(store, item.id))!.item;
    expect([found.runs.length, found.usage]).toEqual([3, usage]);

    const empty = await store.enqueue({ person: "sam", kind: "k", title: "t", trigger: "human" });
    const list = await findItems(store, {});
    expect(Object.fromEntries(list.items.map((i) => [i.id, i.usage]))).toEqual({
      [item.id]: usage,
      [empty.id]: {
        totals: expect.objectContaining({ tokens: 0, costUsd: 0, runs: 0 }),
        models: [],
      },
    });
  });
});

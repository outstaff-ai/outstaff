import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";
import type { ModelCounts } from "#/store/types.js";

const counts = (model: string, n: number, costUsd: number | null = n / 100): ModelCounts => ({
  model,
  inputTokens: n,
  outputTokens: 2 * n,
  cacheReadTokens: 3 * n,
  cacheCreationTokens: 4 * n,
  costUsd,
});

/** What runs used: deltas of sessions' running totals, and the items of a ticket. */
export function usageCases(ctx: ContractContext): void {
  const item = (subject?: { type: string; ref: string }) =>
    ctx.store.enqueue({
      person: "ann",
      kind: "assigned",
      title: "t",
      trigger: "human",
      ...(subject ? { subject } : {}),
    });

  it("records what is new in a session's running total on each run", async () => {
    const a = await item({ type: "ticket", ref: "ACME-1" });
    const first = await ctx.store.startRun(a.id);
    expect(await ctx.store.recordRunUsage(first.id, "s1", [counts("opus", 10)])).toEqual([
      counts("opus", 10),
    ]);

    // The same report again adds nothing; a second model in the same run gets its own row.
    expect(await ctx.store.recordRunUsage(first.id, "s1", [counts("opus", 10)])).toEqual([]);
    await ctx.store.recordRunUsage(first.id, "s2", [counts("haiku", 1, null)]);
    await ctx.store.finishRun(first.id, { outcome: "ok" });

    const second = await ctx.store.startRun(a.id);
    const [added] = await ctx.store.recordRunUsage(second.id, "s1", [counts("opus", 25, 0.4)]);
    expect(added).toMatchObject({ inputTokens: 15, cacheCreationTokens: 60 });
    expect(added?.costUsd).toBeCloseTo(0.3);

    // A total below the previous one started over: it counts whole, and adds to the run's row of that model.
    expect(await ctx.store.recordRunUsage(second.id, "s1", [counts("opus", 5)])).toEqual([
      counts("opus", 5),
    ]);

    const rows = await ctx.store.listRunUsage({ workItemIds: [a.id] });
    const cents = (n: number | null) => (n === null ? null : Math.round(n * 100));
    expect(rows.map((r) => [r.runId, r.model, r.inputTokens, cents(r.costUsd)])).toEqual([
      [first.id, "haiku", 1, null],
      [first.id, "opus", 10, 10],
      [second.id, "opus", 20, 35],
    ]);

    expect(rows[0]).toMatchObject({ workItemId: a.id, person: "ann", kind: "assigned" });
    expect(rows[0]?.finishedAt).not.toBeNull();
    expect(rows[2]?.finishedAt).toBeNull();
    expect(await ctx.store.listRunUsage({ runIds: [second.id] })).toHaveLength(1);
    expect(await ctx.store.listRunUsage({ workItemIds: [] })).toEqual([]);
  });

  it("reads usage by when runs finished", async () => {
    const a = await item();
    const run = await ctx.store.startRun(a.id);
    await ctx.store.recordRunUsage(run.id, "s", [counts("opus", 1)]);
    await ctx.store.finishRun(run.id, { outcome: "ok" });
    const [row] = await ctx.store.listRunUsage({});
    const at = row!.finishedAt!;
    expect(await ctx.store.listRunUsage({ since: at, until: "9999" })).toHaveLength(1);
    expect(await ctx.store.listRunUsage({ until: at })).toEqual([]);
    expect(await ctx.store.listRunUsage({ since: "9999" })).toEqual([]);
  });

  it("finds the items of a ticket by subject or reference, and the ones of none", async () => {
    const own = await item({ type: "ticket", ref: "ACME-1" });
    const pr = await item({ type: "pr", ref: "github.com/acme/shop#7" });
    await ctx.store.addItemRefs(pr.id, [
      { type: "ticket", ref: "ACME-1", role: "inferred", source: "test" },
    ]);

    const chat = await item();
    const other = await item({ type: "ticket", ref: "ACME-2" });
    expect(await ctx.store.itemsOfTicket("ACME-1")).toEqual([own.id, pr.id]);
    expect(await ctx.store.itemsOfTicket("ACME-9")).toEqual([]);
    expect(await ctx.store.itemsWithoutTicket([own.id, pr.id, chat.id, other.id])).toEqual([
      chat.id,
    ]);

    expect(await ctx.store.itemsWithoutTicket([])).toEqual([]);
  });
}

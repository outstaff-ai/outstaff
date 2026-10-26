import { expect, it } from "vitest";
import type { ContractContext } from "../contract.types.js";

/** The loop guard, queue order, activation and failure backoff. */
export function orderingCases(ctx: ContractContext): void {
  it("counts loop-guard entries inside the window only", async () => {
    let t = Date.parse("2030-01-01T00:00:00.000Z");
    await ctx.store.close();
    await ctx.open({ now: () => new Date(t) });
    const item = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "agent",
    });

    const other = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "o",
      trigger: "agent",
    });

    await ctx.store.recordLoopGuard(item.id);
    t += 60_000;
    await ctx.store.recordLoopGuard(item.id);
    await ctx.store.recordLoopGuard(other.id);
    t += 60_000;
    expect(await ctx.store.countLoopGuard(item.id, 10 * 60_000)).toBe(2);
    expect(await ctx.store.countLoopGuard(item.id, 90_000)).toBe(1);
    expect(await ctx.store.countLoopGuard(item.id, 1_000)).toBe(0);
    expect(await ctx.store.countLoopGuard(other.id, 10 * 60_000)).toBe(1);

    await ctx.store.forgetLatestLoopGuard(item.id);
    expect(await ctx.store.countLoopGuard(item.id, 10 * 60_000)).toBe(1);
    expect(await ctx.store.countLoopGuard(other.id, 10 * 60_000)).toBe(1);

    await ctx.store.clearLoopGuard(item.id);
    expect(await ctx.store.countLoopGuard(item.id, 10 * 60_000)).toBe(0);
    expect(await ctx.store.countLoopGuard(other.id, 10 * 60_000)).toBe(1);
  });

  it("orders the queue by priority, then position, then age", async () => {
    const mk = (title: string, extra: { priority?: number; position?: number } = {}) =>
      ctx.store.enqueue({ person: "ann", kind: "k", title, trigger: "human", ...extra });

    const a = await mk("a");
    const b = await mk("b");
    const c = await mk("c");
    expect([a.position, b.position, c.position]).toEqual([1, 2, 3]);
    await mk("front", { position: -5 });
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("front");
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("a");

    await ctx.store.reorderQueue([
      { id: c.id, priority: 100, position: 1 },
      { id: b.id, priority: 100, position: 2 },
    ]);

    expect((await ctx.store.getItem(c.id))?.position).toBe(1);
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("c");
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("b");
    await expect(
      ctx.store.reorderQueue([{ id: "missing", priority: 1, position: 1 }]),
    ).rejects.toThrow(/./);
  });

  it("rolls back a reorder that names an unknown item", async () => {
    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    await expect(
      ctx.store.reorderQueue([
        { id: a.id, priority: 1, position: 9 },
        { id: "missing", priority: 1, position: 1 },
      ]),
    ).rejects.toThrow(/./);

    expect(await ctx.store.getItem(a.id)).toMatchObject({ priority: 100, position: 1 });
  });

  it("activates only queued items, once", async () => {
    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    expect(await ctx.store.activateItem(a.id)).toMatchObject({ status: "active", attempts: 1 });
    expect(await ctx.store.activateItem(a.id)).toBeUndefined();
    expect(await ctx.store.activateItem("missing")).toBeUndefined();
    const got = await Promise.all([ctx.store.activateItem(a.id), ctx.store.activateItem(a.id)]);
    expect(got.filter((x) => x !== undefined)).toHaveLength(0);
  });

  it("stores failures and not_before", async () => {
    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    expect(a).toMatchObject({ failures: 0, notBefore: null });
    await ctx.store.updateItem(a.id, { failures: 2, notBefore: "2030-01-01T00:04:00.000Z" });
    expect(await ctx.store.getItem(a.id)).toMatchObject({
      failures: 2,
      notBefore: "2030-01-01T00:04:00.000Z",
    });

    await ctx.store.updateItem(a.id, { failures: 0, notBefore: null });
    expect(await ctx.store.getItem(a.id)).toMatchObject({ failures: 0, notBefore: null });
  });

  it("keeps failures and not_before across a restart", async () => {
    if (!ctx.h.persistent) {
      return;
    }

    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    await ctx.store.updateItem(a.id, { failures: 2, notBefore: "2030-01-01T00:04:00.000Z" });
    await ctx.store.close();
    await ctx.open();
    expect(await ctx.store.getItem(a.id)).toMatchObject({
      failures: 2,
      notBefore: "2030-01-01T00:04:00.000Z",
    });
  });
}

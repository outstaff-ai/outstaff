import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

/** Cursors and the event log. */
export function eventCases(ctx: ContractContext): void {
  it("migrating is idempotent", async () => {
    await ctx.store.setCursor("github", "etag", "abc");
    await ctx.store.close();
    await ctx.open();
    await ctx.store.close();
    await ctx.open({ migrate: true });
    expect(ctx.h.persistent ? await ctx.store.getCursor("github", "etag") : "abc").toBe("abc");

    await ctx.store.setCursor("github", "etag", "def");
    expect(await ctx.store.getCursor("github", "etag")).toBe("def");
  });

  it("sets, overwrites and scopes cursors", async () => {
    expect(await ctx.store.getCursor("github", "etag")).toBeUndefined();
    await ctx.store.setCursor("github", "etag", "1");
    await ctx.store.setCursor("github", "etag", "2");
    await ctx.store.setCursor("tracker", "etag", "x");
    expect(await ctx.store.getCursor("github", "etag")).toBe("2");
    expect(await ctx.store.getCursor("tracker", "etag")).toBe("x");
  });

  it("dedupes events by source and external id", async () => {
    const e = { source: "github", externalId: "42", type: "pr.opened", payload: { n: 1 } };
    expect(await ctx.store.recordEvent(e)).toBe(true);
    expect(await ctx.store.recordEvent(e)).toBe(false);
    expect(await ctx.store.recordEvent({ ...e, source: "tracker" })).toBe(true);
    expect(await ctx.store.recordEvent({ ...e, externalId: "43" })).toBe(true);
  });

  it("tracks event delivery: unprocessed in order, attempts, processed", async () => {
    const mk = (externalId: string) => ({
      source: "github",
      externalId,
      type: "t",
      payload: { id: externalId },
    });

    await ctx.store.recordEvent(mk("1"));
    await ctx.store.recordEvent(mk("2"));
    await ctx.store.recordEvent(mk("3"));
    expect((await ctx.store.listUnprocessed()).map((e) => e.externalId)).toEqual(["1", "2", "3"]);
    expect(await ctx.store.listUnprocessed(2)).toHaveLength(2);
    expect((await ctx.store.listUnprocessed())[0]).toMatchObject({
      source: "github",
      type: "t",
      payload: { id: "1" },
      attempts: 0,
    });

    expect(await ctx.store.noteEventAttempt("github", "1")).toBe(1);
    expect(await ctx.store.noteEventAttempt("github", "1")).toBe(2);
    await ctx.store.markProcessed("github", "1");
    await ctx.store.markProcessed("github", "2", "gave up");
    await ctx.store.markProcessed("github", "2");
    expect((await ctx.store.listUnprocessed()).map((e) => e.externalId)).toEqual(["3"]);

    // A duplicate is still a duplicate once processed, and does not come back.
    expect(await ctx.store.recordEvent(mk("1"))).toBe(false);
    expect((await ctx.store.listUnprocessed()).map((e) => e.externalId)).toEqual(["3"]);
  });

  it("keeps unprocessed events across a restart", async () => {
    if (!ctx.h.persistent) {
      return;
    }

    await ctx.store.recordEvent({ source: "github", externalId: "1", type: "t", payload: {} });
    await ctx.store.close();
    await ctx.open();
    expect(await ctx.store.listUnprocessed()).toHaveLength(1);
  });
}

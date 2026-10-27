import { expect, it } from "vitest";
import type { ContractContext } from "../contract.types.js";

const trace = (ref: string, at: string, n = 1) => ({
  ref,
  type: "pr.merged",
  at,
  data: { decisions: n, nested: { ok: true } },
});

/** The event pipeline's traces. */
export function traceCases(ctx: ContractContext): void {
  it("records, replaces and pages pipeline traces by event time", async () => {
    expect(await ctx.store.getTrace("vcs:1")).toBeUndefined();
    await ctx.store.recordTrace(trace("vcs:1", "2026-10-01T10:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:2", "2026-10-01T11:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:3", "2026-10-01T12:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:1", "2026-10-01T10:00:00.000Z", 2));

    const one = await ctx.store.getTrace("vcs:1");
    expect(one).toMatchObject({
      ref: "vcs:1",
      type: "pr.merged",
      at: "2026-10-01T10:00:00.000Z",
      data: { decisions: 2, nested: { ok: true } },
    });

    expect(typeof one?.recordedAt).toBe("string");
    expect((await ctx.store.listTraces()).map((t) => t.ref)).toEqual(["vcs:3", "vcs:2", "vcs:1"]);
    expect((await ctx.store.listTraces({ limit: 2 })).map((t) => t.ref)).toEqual([
      "vcs:3",
      "vcs:2",
    ]);

    expect(
      (await ctx.store.listTraces({ before: "2026-10-01T11:00:00.000Z" })).map((t) => t.ref),
    ).toEqual(["vcs:1"]);
  });
}

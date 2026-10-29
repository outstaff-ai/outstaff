import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

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

  it("counts pipeline traces in a window of event time", async () => {
    expect(await ctx.store.countTraces()).toBe(0);
    await ctx.store.recordTrace(trace("vcs:1", "2026-10-01T10:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:2", "2026-10-01T11:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:3", "2026-10-01T12:00:00.000Z"));
    expect(await ctx.store.countTraces()).toBe(3);
    expect(await ctx.store.countTraces({ since: "2026-10-01T10:00:00.000Z" })).toBe(2);
    expect(await ctx.store.countTraces({ before: "2026-10-01T12:00:00.000Z" })).toBe(2);
    expect(
      await ctx.store.countTraces({
        since: "2026-10-01T10:00:00.000Z",
        before: "2026-10-01T12:00:00.000Z",
      }),
    ).toBe(1);
  });

  it("lists pipeline traces in the order they were recorded, from a time on", async () => {
    expect(await ctx.store.listTracesRecorded({ limit: 10 })).toEqual([]);
    await ctx.store.recordTrace(trace("vcs:b", "2026-10-01T09:00:00.000Z"));
    await ctx.store.recordTrace(trace("vcs:a", "2026-10-01T08:00:00.000Z"));
    const all = await ctx.store.listTracesRecorded({ limit: 10 });
    expect(all.map((t) => t.ref).toSorted()).toEqual(["vcs:a", "vcs:b"]);
    expect(all[0]!.recordedAt <= all[1]!.recordedAt).toBe(true);
    expect((await ctx.store.listTracesRecorded({ limit: 1 })).map((t) => t.ref)).toEqual([
      all[0]!.ref,
    ]);

    const from = await ctx.store.listTracesRecorded({ from: all[1]!.recordedAt, limit: 10 });
    expect(from.map((t) => t.ref)).toContain(all[1]!.ref);
    expect(
      await ctx.store.listTracesRecorded({ from: "2999-01-01T00:00:00.000Z", limit: 10 }),
    ).toEqual([]);
  });
}

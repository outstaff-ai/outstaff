import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

/** Runs, the journal, subjects and links. */
export function recordCases(ctx: ContractContext): void {
  it("records runs", async () => {
    const item = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "human",
    });

    const run = await ctx.store.startRun(item.id);
    expect(run.finishedAt).toBeNull();
    await ctx.store.finishRun(run.id, { outcome: "ok", usage: { tokens: 5 } });
    const [done] = await ctx.store.listRuns(item.id);
    expect(done).toMatchObject({ outcome: "ok", usage: { tokens: 5 }, error: null });
    expect(done?.finishedAt).not.toBeNull();
    await expect(ctx.store.finishRun("missing", { outcome: "ok" })).rejects.toThrow(/./);
  });

  it("tags the open run with its runtime and model", async () => {
    const item = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "human",
    });

    await ctx.store.tagRun(item.id, { runtime: "claude" });
    expect(await ctx.store.listRuns(item.id)).toEqual([]);

    const run = await ctx.store.startRun(item.id);
    expect(run).toMatchObject({ runtime: null, model: null });
    await ctx.store.tagRun(item.id, { runtime: "claude", model: "opus" });
    await ctx.store.tagRun(item.id, { model: "opus-4" });
    await ctx.store.tagRun(item.id, {});
    expect((await ctx.store.listRuns(item.id))[0]).toMatchObject({
      runtime: "claude",
      model: "opus-4",
    });

    await ctx.store.finishRun(run.id, { outcome: "ok" });
    await ctx.store.tagRun(item.id, { runtime: "other" });
    expect((await ctx.store.listRuns(item.id))[0]).toMatchObject({ runtime: "claude" });
  });

  it("keeps a journal per item, in order", async () => {
    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    const b = await ctx.store.enqueue({ person: "ann", kind: "k", title: "b", trigger: "human" });
    for (const text of ["one", "two", "three"]) {
      await ctx.store.appendJournal(a.id, "ann", text);
    }

    await ctx.store.appendJournal(b.id, "ann", "other");
    expect((await ctx.store.readJournal(a.id)).map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(await ctx.store.readJournal(b.id)).toHaveLength(1);
    await expect(ctx.store.appendJournal("missing", "ann", "x")).rejects.toThrow(/./);
  });

  it("upserts subjects", async () => {
    expect(await ctx.store.getSubject("pr", "acme/web#1")).toBeUndefined();
    await ctx.store.upsertSubject("pr", "acme/web#1", { state: "open", labels: ["a"] });
    await ctx.store.upsertSubject("pr", "acme/web#1", { state: "merged" });
    expect(await ctx.store.getSubject("pr", "acme/web#1")).toMatchObject({
      data: { state: "merged" },
    });
  });

  it("links, queries and unlinks edges idempotently", async () => {
    const t = { type: "ticket", ref: "ACME-1" };
    const pr = { type: "pr", ref: "acme/web#1" };
    const ann = { type: "person", ref: "ann" };
    const l1 = await ctx.store.link(t, pr, "implemented-by");
    const l2 = await ctx.store.link(t, pr, "implemented-by");
    expect(l2.id).toBe(l1.id);
    await ctx.store.link(pr, ann, "authored-by");
    await ctx.store.link(pr, { type: "pr", ref: "acme/web#0" }, "stacked-on");

    expect(await ctx.store.queryLinks({ from: t })).toHaveLength(1);
    expect(await ctx.store.queryLinks({ from: pr })).toHaveLength(2);
    expect(await ctx.store.queryLinks({ to: pr })).toHaveLength(1);
    expect(await ctx.store.queryLinks({ from: pr, relation: "stacked-on" })).toHaveLength(1);
    expect(await ctx.store.queryLinks({})).toHaveLength(3);

    expect(await ctx.store.unlink(t, pr, "implemented-by")).toBe(1);
    expect(await ctx.store.unlink(t, pr, "implemented-by")).toBe(0);
    expect(await ctx.store.queryLinks({ from: t })).toHaveLength(0);
  });
}

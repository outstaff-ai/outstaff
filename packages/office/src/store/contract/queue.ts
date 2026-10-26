import { expect, it } from "vitest";
import type { ContractContext } from "../contract.types.js";

/** Work items: enqueueing, dequeueing and updates. */
export function queueCases(ctx: ContractContext): void {
  it("enqueues and dequeues by priority, then age, per person", async () => {
    const mk = (person: string, title: string, priority?: number) =>
      ctx.store.enqueue({
        person,
        kind: "assignment",
        title,
        trigger: "human",
        ...(priority === undefined ? {} : { priority }),
      });

    await mk("ann", "old normal");
    await mk("ann", "urgent", 1);
    await mk("ann", "new normal");
    await mk("bob", "bobs");

    const first = await ctx.store.dequeueNext("ann");
    expect(first).toMatchObject({ title: "urgent", status: "active", attempts: 1 });
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("old normal");
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("new normal");
    expect(await ctx.store.dequeueNext("ann")).toBeUndefined();
    expect((await ctx.store.dequeueNext("bob"))?.title).toBe("bobs");
  });

  it("never hands the same item to concurrent dequeues", async () => {
    for (let i = 0; i < 6; i++) {
      await ctx.store.enqueue({ person: "ann", kind: "k", title: `t${i}`, trigger: "human" });
    }

    const got = await Promise.all(Array.from({ length: 10 }, () => ctx.store.dequeueNext("ann")));
    const ids = got.filter((x) => x !== undefined).map((x) => x.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("round-trips item fields and updates", async () => {
    const parent = await ctx.store.enqueue({
      person: "ann",
      kind: "ticket",
      title: "p",
      trigger: "human",
    });

    const child = await ctx.store.enqueue({
      person: "bob",
      kind: "question",
      title: "c",
      trigger: "agent",
      parentId: parent.id,
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect(child).toMatchObject({
      parentId: parent.id,
      subject: { type: "ticket", ref: "ACME-1" },
      status: "queued",
      trigger: "agent",
      priority: 100,
      attempts: 0,
      sessionId: null,
    });

    const updated = await ctx.store.updateItem(child.id, {
      status: "waiting",
      sessionId: "s1",
      workspace: "/w",
    });

    expect(updated).toMatchObject({ status: "waiting", sessionId: "s1", workspace: "/w" });
    expect(await ctx.store.getItem(child.id)).toEqual(updated);
    expect(await ctx.store.getItem("missing")).toBeUndefined();
    await expect(ctx.store.updateItem("missing", { status: "done" })).rejects.toThrow(/./);
    expect((await ctx.store.listItems({ person: "bob" })).map((i) => i.id)).toEqual([child.id]);
    expect(await ctx.store.listItems({ status: "waiting" })).toHaveLength(1);
    expect(await ctx.store.listItems()).toHaveLength(2);
  });

  it("rejects an unknown status", async () => {
    const item = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "human",
    });

    await expect(ctx.store.updateItem(item.id, { status: "bogus" as never })).rejects.toThrow(/./);
  });
}

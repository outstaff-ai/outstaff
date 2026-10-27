import { expect, it } from "vitest";
import type { ContractContext } from "#/store/contract.types.js";

/** Pauses, conversations and losing the store. */
export function pauseCases(ctx: ContractContext): void {
  it("persists pauses by scope", async () => {
    expect(await ctx.store.listPauses()).toEqual([]);
    await ctx.store.setPause("team", "release freeze");
    await ctx.store.setPause("team", "ignored second reason");
    await ctx.store.setPause("person:ann");
    const pauses = await ctx.store.listPauses();
    expect(pauses.map((p) => [p.scope, p.reason])).toEqual([
      ["person:ann", null],
      ["team", "release freeze"],
    ]);

    expect(await ctx.store.clearPause("team")).toBe(true);
    expect(await ctx.store.clearPause("team")).toBe(false);
    expect((await ctx.store.listPauses()).map((p) => p.scope)).toEqual(["person:ann"]);
  });

  it("keeps queue order and pauses across a restart", async () => {
    if (!ctx.h.persistent) {
      return;
    }

    const a = await ctx.store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
    const b = await ctx.store.enqueue({ person: "ann", kind: "k", title: "b", trigger: "human" });
    await ctx.store.reorderQueue([
      { id: b.id, priority: 100, position: 1 },
      { id: a.id, priority: 100, position: 2 },
    ]);

    await ctx.store.setPause("team");
    await ctx.store.close();
    await ctx.open();
    expect((await ctx.store.listPauses()).map((p) => p.scope)).toEqual(["team"]);
    expect((await ctx.store.dequeueNext("ann"))?.title).toBe("b");
  });

  it("creates and answers conversations once", async () => {
    const asker = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "human",
    });

    const c = await ctx.store.createConversation({
      askerItemId: asker.id,
      target: "bob",
      question: "why?",
      depth: 1,
    });

    expect(c).toMatchObject({ status: "open", answer: null, depth: 1 });
    const answered = await ctx.store.answerConversation(c.id, "because");
    expect(answered).toMatchObject({ status: "answered", answer: "because" });
    expect(answered.answeredAt).not.toBeNull();
    expect(await ctx.store.getConversation(c.id)).toEqual(answered);
    await expect(ctx.store.answerConversation(c.id, "again")).rejects.toThrow(/./);
    await expect(ctx.store.answerConversation("missing", "x")).rejects.toThrow(/./);
  });

  it("tracks which answers reached the asker", async () => {
    const asker = await ctx.store.enqueue({
      person: "ann",
      kind: "k",
      title: "t",
      trigger: "human",
    });

    const make = (q: string) =>
      ctx.store.createConversation({ askerItemId: asker.id, target: "bob", question: q });

    const a = await make("one");
    const b = await make("two");
    await make("open");
    expect(await ctx.store.listUndelivered(asker.id)).toEqual([]);
    await ctx.store.answerConversation(b.id, "b");
    await ctx.store.answerConversation(a.id, "a");
    expect((await ctx.store.listUndelivered(asker.id)).map((c) => c.id).toSorted()).toEqual(
      [a.id, b.id].toSorted(),
    );

    await ctx.store.markDelivered(b.id);
    await ctx.store.markDelivered(b.id);
    expect((await ctx.store.listUndelivered(asker.id)).map((c) => c.id)).toEqual([a.id]);
    expect((await ctx.store.getConversation(b.id))?.deliveredAt).not.toBeNull();
    expect(await ctx.store.listUndelivered("other")).toEqual([]);
  });

  it("losing the store only costs a rescan", async () => {
    await ctx.store.setCursor("github", "etag", "abc");
    await ctx.store.recordEvent({ source: "github", externalId: "1", type: "t", payload: {} });
    await ctx.store.close();
    await ctx.h.lose();

    await ctx.open();
    expect(await ctx.store.getCursor("github", "etag")).toBeUndefined();
    // The rescan re-reads the same events and they are accepted again.
    expect(
      await ctx.store.recordEvent({ source: "github", externalId: "1", type: "t", payload: {} }),
    ).toBe(true);

    await ctx.store.setCursor("github", "etag", "abc");
    expect(await ctx.store.getCursor("github", "etag")).toBe("abc");
  });
}

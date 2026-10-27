import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

/** What work items refer to, and when and how each reference was added. */
export function refCases(ctx: ContractContext): void {
  it("records an item's references as they become known, and returns them in one query", async () => {
    const item = await ctx.store.enqueue({
      person: "kofi",
      kind: "assigned",
      title: "Fix the checkout",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-41" },
      source: "work_link",
      refs: [
        { type: "chat_thread", ref: "D1:100.1", role: "trigger", source: "chat:D1:100.1" },
        { type: "chat_message", ref: "D1:100.1", role: "trigger", source: "chat:D1:100.1" },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await ctx.store.addItemRefs(item.id, [
      {
        type: "pr",
        ref: "acme/app#12",
        role: "inferred",
        source: "workstate:implements",
      },
    ]);

    // Known again, by another way: the first record stays, and only gains a link it lacked.
    await ctx.store.addItemRefs(item.id, [
      {
        type: "pr",
        ref: "acme/app#12",
        url: "https://git.acme.example/acme/app/pull/12",
        role: "trigger",
        source: "vcs:evt-9",
      },
    ]);

    const refs = await ctx.store.listItemRefs(item.id);
    expect(refs.map((r) => [r.type, r.ref, r.role, r.source])).toEqual([
      ["chat_message", "D1:100.1", "trigger", "chat:D1:100.1"],
      ["chat_thread", "D1:100.1", "trigger", "chat:D1:100.1"],
      ["ticket", "ACME-41", "subject", "work_link"],
      ["pr", "acme/app#12", "inferred", "workstate:implements"],
    ]);

    expect(refs[3]).toMatchObject({
      workItemId: item.id,
      url: "https://git.acme.example/acme/app/pull/12",
    });

    expect(refs[0]!.addedAt).toBe(refs[2]!.addedAt);
    expect(refs[3]!.addedAt > refs[2]!.addedAt).toBe(true);
    expect(refs[2]).not.toHaveProperty("url");
  });

  it("finds every item that refers to something, oldest first", async () => {
    const a = await ctx.store.enqueue({
      person: "kofi",
      kind: "assigned",
      title: "a",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-7" },
    });

    const b = await ctx.store.enqueue({
      person: "kofi",
      kind: "chat",
      title: "b",
      trigger: "human",
      subject: { type: "chat", ref: "D1:1" },
    });

    await ctx.store.addItemRefs(b.id, [
      { type: "ticket", ref: "ACME-7", role: "mentioned", source: "chat:D1:2" },
    ]);

    const found = await ctx.store.findItemRefs("ticket", "ACME-7");
    expect(found.map((r) => [r.workItemId, r.role, r.source])).toEqual([
      [a.id, "subject", "office"],
      [b.id, "mentioned", "chat:D1:2"],
    ]);

    // A chat subject is no reference by itself: the chat desk records the thread.
    expect(await ctx.store.listItemRefs(b.id)).toHaveLength(1);
    expect(await ctx.store.findItemRefs("pr", "acme/app#1")).toEqual([]);
  });

  it("stamps when an edge was linked", async () => {
    const link = await ctx.store.link(
      { type: "pr", ref: "acme/app#12" },
      { type: "ticket", ref: "ACME-41" },
      "implements",
    );

    expect(typeof link.createdAt).toBe("string");
    expect((await ctx.store.queryLinks({}))[0]!.createdAt).toBe(link.createdAt);
  });
}

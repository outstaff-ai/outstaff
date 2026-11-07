import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

const T1 = "2026-10-01T06:00:00.000Z";
const T2 = "2026-10-01T06:05:00.000Z";
const T3 = "2026-10-01T06:10:00.000Z";

/** The chat cursors: one per person and conversation, only ever moving forward. */
export function chatCursorCases(ctx: ContractContext): void {
  it("keeps the latest time per conversation and lists a person's latest first", async () => {
    expect(await ctx.store.listChatCursors("sam", 10)).toEqual([]);

    await ctx.store.advanceChatCursor("sam", { channel: "D1", at: T1 });
    await ctx.store.advanceChatCursor("sam", { channel: "D1", at: T2 });
    // An older message taken in late leaves the cursor where it is.
    await ctx.store.advanceChatCursor("sam", { channel: "D1", at: T1 });
    await ctx.store.advanceChatCursor("sam", { channel: "C1", thread: "100.1", at: T3 });
    await ctx.store.advanceChatCursor("pia", { channel: "D1", at: T3 });

    expect(await ctx.store.listChatCursors("sam", 10)).toEqual([
      { channel: "C1", thread: "100.1", at: T3 },
      { channel: "D1", at: T2 },
    ]);

    expect(await ctx.store.listChatCursors("sam", 1)).toEqual([
      { channel: "C1", thread: "100.1", at: T3 },
    ]);
  });

  it("keeps the cursors when the store is opened again", async () => {
    await ctx.store.advanceChatCursor("sam", { channel: "D1", thread: "100.1", at: T2 });
    await ctx.store.close();
    await ctx.open();
    expect(await ctx.store.listChatCursors("sam", 10)).toEqual(
      ctx.h.persistent ? [{ channel: "D1", thread: "100.1", at: T2 }] : [],
    );
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "#/store/index.js";
import { countEvents } from "#/link/totals.js";
import { record, trace } from "./support.js";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 5, 9, 0, 0, ms)).toISOString();

describe("countEvents", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  it("counts by event time alone when no filter looks inside the traces, and ignores paging", async () => {
    await record(store, trace("a", at(1)));
    await record(store, trace("b", at(2)));
    await record(store, trace("c", at(3)));
    expect(await countEvents(store, {})).toBe(3);
    expect(await countEvents(store, { limit: 1, before: at(3) })).toBe(3);
    expect(await countEvents(store, { since: at(1) })).toBe(2);
  });

  it("counts the events a filter matches, past one page of the store and after `since`", async () => {
    for (let i = 0; i < 450; i++) {
      await record(store, trace(`t:${i}`, at(i), { ticket: i % 3 === 0 ? "ACME-1" : "ACME-2" }));
    }

    expect(await countEvents(store, { ticket: "ACME-1" })).toBe(150);
    expect(await countEvents(store, { ticket: "ACME-1", limit: 5, before: at(10) })).toBe(150);
    expect(await countEvents(store, { ticket: "ACME-1", since: at(300) })).toBe(49);
    expect(await countEvents(store, { ticket: "ACME-404" })).toBe(0);
  });
});

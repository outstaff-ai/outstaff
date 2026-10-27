import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../../store/index.js";
import { findEvents, SCAN_LIMIT } from "../events.js";
import { record, trace } from "./support.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 9, minute)).toISOString();

describe("findEvents", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  const ids = (r: Awaited<ReturnType<typeof findEvents>>) => r.events.map((t) => t.event.id);

  it("filters by source, person, ticket and pull request, newest first", async () => {
    await record(store, trace("vcs:1", at(1), { pr: 9, actor: "ada-admin" }));
    await record(store, trace("tracker:2", at(2), { ticket: "ACME-1", wake: "sam" }));
    await record(store, trace("workstate:3", at(3), { ticket: "ACME-2", actor: "sam" }));
    await record(store, trace("workstate:4", at(4), { ticket: "ACME-1", act: "sam" }));
    await record(store, trace("vcs:5", at(5), { pr: 10 }));

    expect(ids(await findEvents(store, {}))).toEqual([
      "vcs:5",
      "workstate:4",
      "workstate:3",
      "tracker:2",
      "vcs:1",
    ]);

    expect(ids(await findEvents(store, { source: "vcs" }))).toEqual(["vcs:5", "vcs:1"]);
    expect(ids(await findEvents(store, { person: "sam" }))).toEqual([
      "workstate:4",
      "workstate:3",
      "tracker:2",
    ]);

    expect(ids(await findEvents(store, { ticket: "ACME-1" }))).toEqual([
      "workstate:4",
      "tracker:2",
    ]);

    expect(ids(await findEvents(store, { pr: "acme-example/shop#9" }))).toEqual(["vcs:1"]);
    expect(ids(await findEvents(store, { since: at(3) }))).toEqual(["vcs:5", "workstate:4"]);
    expect(await findEvents(store, { since: at(9) })).toEqual({ events: [] });
  });

  it("pages by time without splitting the events of one time", async () => {
    await record(store, trace("a", at(1)));
    await record(store, trace("b", at(2)));
    await record(store, trace("c", at(2)));
    await record(store, trace("d", at(3)));
    const first = await findEvents(store, { limit: 2 });
    expect([ids(first).toSorted(), first.nextBefore]).toEqual([["b", "c", "d"], at(2)]);
    const second = await findEvents(store, { limit: 2, before: first.nextBefore });
    expect(second).toEqual({
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "a" }) })],
    });
  });

  it("reads past a full page of the store, and stops looking after a bounded number of traces", async () => {
    for (let i = 0; i < 250; i++) {
      await record(
        store,
        trace(`t:${i}`, new Date(Date.UTC(2026, 9, 5, 9, 0, 0, i)).toISOString(), {
          ticket: i === 3 ? "ACME-9" : "ACME-1",
        }),
      );
    }

    expect(ids(await findEvents(store, { ticket: "ACME-9" }))).toEqual(["t:3"]);
    expect(SCAN_LIMIT).toBe(2000);
    expect(await findEvents(store, { ticket: "ACME-404" })).toEqual({ events: [] });

    // Past the bound it answers with what it found and where to go on from.
    const capped = await findEvents(store, { ticket: "ACME-9" }, 100);
    expect(capped).toEqual({
      events: [],
      nextBefore: new Date(Date.UTC(2026, 9, 5, 9, 0, 0, 150)).toISOString(),
    });

    expect(ids(await findEvents(store, { ticket: "ACME-9", before: capped.nextBefore }))).toEqual([
      "t:3",
    ]);
  });
});

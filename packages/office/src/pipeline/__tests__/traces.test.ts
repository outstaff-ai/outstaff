import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "#/store/index.js";
import { createMemoryTraceStore } from "#/pipeline/memory-traces.js";
import { createStoreTraceStore } from "#/pipeline/store-traces.js";
import type { Trace, TraceStore } from "#/pipeline/trace.types.js";
import { event } from "./support.js";

const trace = (id: string, at: string): Trace => ({
  event: event("ticket.assigned", { id, at, subject: { ticket: "ACME-1" } }),
  policies: [],
  decisions: [{ type: "drop", reason: "no policy matched" }],
});

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

const kinds: [string, () => Promise<TraceStore>][] = [
  ["in memory", async () => createMemoryTraceStore()],
  [
    "in the office store",
    async () => {
      store = await openStore("sqlite::memory:");
      return createStoreTraceStore(store);
    },
  ],
];

describe.each(kinds)("traces %s", (_name, make) => {
  it("records, replaces and finds a trace by its event id", async () => {
    const traces = await make();
    expect(await traces.get("tracker:1")).toBeUndefined();
    await traces.record(trace("tracker:1", "2026-10-05T09:00:00.000Z"));
    const replaced = trace("tracker:1", "2026-10-05T09:00:00.000Z");
    replaced.decisions = [];
    await traces.record(replaced);
    expect(await traces.get("tracker:1")).toEqual(replaced);
  });

  it("keeps the act results of a trace that is recorded again", async () => {
    const traces = await make();
    const done = {
      ...trace("e", "2026-10-05T09:00:00.000Z"),
      results: { "e:p": { ok: true, results: ["moved"] } },
    };

    await traces.record(done);
    await traces.record(trace("e", "2026-10-05T09:00:00.000Z"));
    expect((await traces.get("e"))?.results).toEqual(done.results);
  });

  it("lists the newest event first, by time, in pages", async () => {
    const traces = await make();
    await traces.record(trace("a", "2026-10-05T09:00:00.000Z"));
    await traces.record(trace("c", "2026-10-05T11:00:00.000Z"));
    await traces.record(trace("b", "2026-10-05T10:00:00.000Z"));
    const ids = (list: Trace[]) => list.map((t) => t.event.id);
    expect(ids(await traces.list())).toEqual(["c", "b", "a"]);
    expect(ids(await traces.list({ limit: 1 }))).toEqual(["c"]);
    expect(ids(await traces.list({ before: "2026-10-05T11:00:00.000Z" }))).toEqual(["b", "a"]);
  });
});

describe("the in-memory trace store", () => {
  it("hands out copies, so a caller cannot change what was recorded", async () => {
    const traces = createMemoryTraceStore();
    const t = trace("a", "2026-10-05T09:00:00.000Z");
    await traces.record(t);
    t.decisions.length = 0;
    const got = (await traces.get("a"))!;
    got.policies.push({ policy: "x", matched: false, reason: "", decisions: [] });
    expect(await traces.get("a")).toEqual(trace("a", "2026-10-05T09:00:00.000Z"));
  });
});

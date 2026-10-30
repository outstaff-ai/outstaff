import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "#/store/index.js";
import { createMemoryTraceStore } from "#/pipeline/memory-traces.js";
import { createActQueue } from "#/pipeline/act/pending.js";
import { actRecords } from "#/pipeline/act/results.js";

const AT = "2030-01-01T00:00:00.000Z";
const move = (ticket: string) => [{ op: "move" as const, ticket, to: "review" as const }];

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

describe("the act queue", () => {
  it("keeps each person's acts once, in order, until taken", async () => {
    store = await openStore("sqlite::memory:");
    const queue = createActQueue(store);
    await Promise.all([
      queue.add("sam", { id: "a", ops: move("ACME-1"), event: "e" }),
      queue.add("sam", { id: "b", ops: move("ACME-2") }),
      queue.add("sam", { id: "a", ops: move("ACME-1"), event: "e" }),
      queue.add("mira", { id: "c", ops: move("ACME-3") }),
    ]);

    expect((await queue.list("sam")).map((a) => a.id)).toEqual(["a", "b"]);
    expect(await queue.take("sam", "c")).toBeUndefined();
    expect(await queue.take("sam", "a")).toEqual({ id: "a", ops: move("ACME-1"), event: "e" });
    expect((await queue.list("sam")).map((a) => a.id)).toEqual(["b"]);
    expect((await queue.list("mira")).map((a) => a.id)).toEqual(["c"]);
  });

  it("goes on after a write that failed", async () => {
    store = await openStore("sqlite::memory:");
    const real = store;
    let fail = true;
    const queue = createActQueue({
      getSubject: (type, ref) => real.getSubject(type, ref),
      upsertSubject: (type, ref, data) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("store down"));
        }

        return real.upsertSubject(type, ref, data);
      },
    });

    await expect(queue.add("sam", { id: "a", ops: move("ACME-1") })).rejects.toThrow("store down");
    await queue.add("sam", { id: "b", ops: move("ACME-2") });
    expect((await queue.list("sam")).map((a) => a.id)).toEqual(["b"]);
  });
});

describe("actRecords", () => {
  it("goes on after a change that failed", async () => {
    const traces = createMemoryTraceStore();
    let fail = true;
    const flaky = {
      ...traces,
      get: (id: string) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("store down"));
        }

        return traces.get(id);
      },
    };

    const update = actRecords(flaky);
    const record = () => ({ status: "queued" as const, queuedAt: AT, results: [] });
    await expect(update("e", "e:p", record)).rejects.toThrow("store down");
    await expect(update("e", "e:p", record)).resolves.toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ITEM_EVENTS_SUBJECT, WAKE_SUBJECT } from "../../pipeline/live/wake.js";
import { openStore, type Store } from "../../store/index.js";
import { findItem } from "../item.js";
import { record, trace } from "./support.js";

describe("findItem", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  it("gives the item, its runs, the end of its journal and the events that queued or joined it", async () => {
    const item = await store.enqueue({
      person: "sam",
      kind: "review_feedback",
      title: "review feedback: PR #9",
      trigger: "human",
      subject: { type: "pr", ref: "github.com/acme-example/shop#9" },
    });

    await store.activateItem(item.id);
    const run = await store.startRun(item.id);
    await store.finishRun(run.id, { outcome: "done" });
    for (let i = 1; i <= 6; i++) {
      await store.appendJournal(item.id, "sam", i === 6 ? "x".repeat(600) : `entry ${i}`);
    }

    await store.upsertSubject(WAKE_SUBJECT, item.id, {
      event: "vcs:2",
      policy: "review_to_author",
    });

    await store.upsertSubject(ITEM_EVENTS_SUBJECT, item.id, ["vcs:2", "vcs:1", "vcs:gone"]);
    await record(store, trace("vcs:1", "2026-10-05T09:01:00.000Z"));
    await record(store, trace("vcs:2", "2026-10-05T09:00:00.000Z"));

    const found = (await findItem(store, item.id))!;
    expect(found.item).toMatchObject({
      id: item.id,
      person: "sam",
      status: "active",
      scheduledBy: { policy: "review_to_author", eventId: "vcs:2" },
      runs: [
        { startedAt: run.startedAt, finishedAt: expect.any(String), outcome: "done", error: null },
      ],
    });

    expect(found.item.journal.entries).toBe(6);
    expect(found.item.journal.latest.map((j) => j.text.slice(0, 7))).toEqual([
      "entry 2",
      "entry 3",
      "entry 4",
      "entry 5",
      "xxxxxxx",
    ]);

    expect(found.item.journal.latest.at(-1)!.text).toHaveLength(501);
    expect(found.traces.map((t) => t.event.id)).toEqual(["vcs:2", "vcs:1"]);
  });

  it("gives an item the pipeline did not queue, and nothing for an unknown id", async () => {
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
    });

    expect(await findItem(store, item.id)).toMatchObject({
      item: { scheduledBy: null, runs: [], journal: { entries: 0, latest: [] } },
      traces: [],
    });

    expect(await findItem(store, "nope")).toBeUndefined();
  });
});

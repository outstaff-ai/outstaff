import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WAKE_SUBJECT } from "#/pipeline/live/wake.js";
import { openStore, type Store } from "#/store/index.js";
import { findItems } from "#/link/items.js";

describe("findItems", () => {
  let store: Store;
  let now = Date.UTC(2026, 9, 5, 9);
  beforeEach(async () => {
    store = await openStore("sqlite::memory:", { now: () => new Date(now) });
  });

  afterEach(async () => {
    await store.close();
  });

  const add = async (person: string, minute: number, kind = "assigned") => {
    now = Date.UTC(2026, 9, 5, 9, minute);
    return store.enqueue({ person, kind, title: `${kind} ${minute}`, trigger: "human" });
  };

  it("lists items newest first, filtered by status and person, paged by creation time without splitting one", async () => {
    const a = await add("sam", 1);
    const b = await add("noor", 2);
    const c = await add("sam", 3);
    const d = await add("sam", 3, "ci_failed");
    await store.activateItem(a.id);
    await store.upsertSubject(WAKE_SUBJECT, d.id, {
      event: "vcs:9",
      policy: "ci_failed_to_author",
    });

    const ids = (r: Awaited<ReturnType<typeof findItems>>) => r.items.map((i) => i.id).toSorted();
    expect(ids(await findItems(store, {}))).toEqual([a.id, b.id, c.id, d.id].toSorted());
    expect(ids(await findItems(store, { person: "sam", status: "queued" }))).toEqual(
      [c.id, d.id].toSorted(),
    );

    const first = await findItems(store, { limit: 1 });
    expect([ids(first), first.nextBefore]).toEqual([[c.id, d.id].toSorted(), c.createdAt]);
    const second = await findItems(store, { limit: 1, before: first.nextBefore });
    expect([ids(second), second.nextBefore]).toEqual([[b.id], b.createdAt]);
    expect(await findItems(store, { before: b.createdAt })).toMatchObject({
      items: [{ id: a.id, status: "active" }],
    });

    expect(
      (await findItems(store, { person: "sam", status: "queued" })).items.find(
        (i) => i.id === d.id,
      ),
    ).toMatchObject({
      scheduledBy: { policy: "ci_failed_to_author", eventId: "vcs:9" },
    });
  });
});

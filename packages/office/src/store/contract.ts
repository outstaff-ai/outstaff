import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenStoreOptions } from "./open.js";
import type { Store } from "./types.js";

export interface StoreHarness {
  /** False when data does not survive close() (in-memory). */
  persistent: boolean;

  /** Opens a store on this harness's storage, running migrations. Can be called again after close(). */
  open(opts?: OpenStoreOptions): Promise<Store>;

  /** Destroys the underlying storage (file, schema), as if the store were lost. */
  lose(): Promise<void>;

  /** Removes everything the harness created. */
  cleanup(): Promise<void>;
}

/** Runs the store contract against a fresh, isolated storage per test. */
export function storeContract(name: string, makeHarness: () => StoreHarness): void {
  describe(`store contract: ${name}`, () => {
    let h: StoreHarness;
    let store: Store;
    const open = async (opts?: OpenStoreOptions) => (store = await h.open(opts));

    beforeEach(async () => {
      h = makeHarness();
      await open();
    });

    afterEach(async () => {
      await store.close().catch(() => undefined);
      await h.cleanup();
    });

    it("migrating is idempotent", async () => {
      await store.setCursor("github", "etag", "abc");
      await store.close();
      await open();
      await store.close();
      await open({ migrate: true });
      expect(h.persistent ? await store.getCursor("github", "etag") : "abc").toBe("abc");

      await store.setCursor("github", "etag", "def");
      expect(await store.getCursor("github", "etag")).toBe("def");
    });

    it("sets, overwrites and scopes cursors", async () => {
      expect(await store.getCursor("github", "etag")).toBeUndefined();
      await store.setCursor("github", "etag", "1");
      await store.setCursor("github", "etag", "2");
      await store.setCursor("tracker", "etag", "x");
      expect(await store.getCursor("github", "etag")).toBe("2");
      expect(await store.getCursor("tracker", "etag")).toBe("x");
    });

    it("dedupes events by source and external id", async () => {
      const e = { source: "github", externalId: "42", type: "pr.opened", payload: { n: 1 } };
      expect(await store.recordEvent(e)).toBe(true);
      expect(await store.recordEvent(e)).toBe(false);
      expect(await store.recordEvent({ ...e, source: "tracker" })).toBe(true);
      expect(await store.recordEvent({ ...e, externalId: "43" })).toBe(true);
    });

    it("enqueues and dequeues by priority, then age, per person", async () => {
      const mk = (person: string, title: string, priority?: number) =>
        store.enqueue({
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

      const first = await store.dequeueNext("ann");
      expect(first).toMatchObject({ title: "urgent", status: "active", attempts: 1 });
      expect((await store.dequeueNext("ann"))?.title).toBe("old normal");
      expect((await store.dequeueNext("ann"))?.title).toBe("new normal");
      expect(await store.dequeueNext("ann")).toBeUndefined();
      expect((await store.dequeueNext("bob"))?.title).toBe("bobs");
    });

    it("never hands the same item to concurrent dequeues", async () => {
      for (let i = 0; i < 6; i++) {
        await store.enqueue({ person: "ann", kind: "k", title: `t${i}`, trigger: "human" });
      }

      const got = await Promise.all(Array.from({ length: 10 }, () => store.dequeueNext("ann")));
      const ids = got.filter((x) => x !== undefined).map((x) => x.id);
      expect(ids).toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
    });

    it("round-trips item fields and updates", async () => {
      const parent = await store.enqueue({
        person: "ann",
        kind: "ticket",
        title: "p",
        trigger: "human",
      });

      const child = await store.enqueue({
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

      const updated = await store.updateItem(child.id, {
        status: "waiting",
        sessionId: "s1",
        workspace: "/w",
      });

      expect(updated).toMatchObject({ status: "waiting", sessionId: "s1", workspace: "/w" });
      expect(await store.getItem(child.id)).toEqual(updated);
      expect(await store.getItem("missing")).toBeUndefined();
      await expect(store.updateItem("missing", { status: "done" })).rejects.toThrow(/./);
      expect((await store.listItems({ person: "bob" })).map((i) => i.id)).toEqual([child.id]);
      expect(await store.listItems({ status: "waiting" })).toHaveLength(1);
      expect(await store.listItems()).toHaveLength(2);
    });

    it("rejects an unknown status", async () => {
      const item = await store.enqueue({ person: "ann", kind: "k", title: "t", trigger: "human" });
      await expect(store.updateItem(item.id, { status: "bogus" as never })).rejects.toThrow(/./);
    });

    it("records runs", async () => {
      const item = await store.enqueue({ person: "ann", kind: "k", title: "t", trigger: "human" });
      const run = await store.startRun(item.id);
      expect(run.finishedAt).toBeNull();
      await store.finishRun(run.id, { outcome: "ok", usage: { tokens: 5 } });
      const [done] = await store.listRuns(item.id);
      expect(done).toMatchObject({ outcome: "ok", usage: { tokens: 5 }, error: null });
      expect(done?.finishedAt).not.toBeNull();
      await expect(store.finishRun("missing", { outcome: "ok" })).rejects.toThrow(/./);
    });

    it("keeps a journal per item, in order", async () => {
      const a = await store.enqueue({ person: "ann", kind: "k", title: "a", trigger: "human" });
      const b = await store.enqueue({ person: "ann", kind: "k", title: "b", trigger: "human" });
      for (const text of ["one", "two", "three"]) {
        await store.appendJournal(a.id, "ann", text);
      }

      await store.appendJournal(b.id, "ann", "other");
      expect((await store.readJournal(a.id)).map((e) => e.text)).toEqual(["one", "two", "three"]);
      expect(await store.readJournal(b.id)).toHaveLength(1);
      await expect(store.appendJournal("missing", "ann", "x")).rejects.toThrow(/./);
    });

    it("upserts subjects", async () => {
      expect(await store.getSubject("pr", "acme/web#1")).toBeUndefined();
      await store.upsertSubject("pr", "acme/web#1", { state: "open", labels: ["a"] });
      await store.upsertSubject("pr", "acme/web#1", { state: "merged" });
      expect(await store.getSubject("pr", "acme/web#1")).toMatchObject({
        data: { state: "merged" },
      });
    });

    it("links, queries and unlinks edges idempotently", async () => {
      const t = { type: "ticket", ref: "ACME-1" };
      const pr = { type: "pr", ref: "acme/web#1" };
      const ann = { type: "person", ref: "ann" };
      const l1 = await store.link(t, pr, "implemented-by");
      const l2 = await store.link(t, pr, "implemented-by");
      expect(l2.id).toBe(l1.id);
      await store.link(pr, ann, "authored-by");
      await store.link(pr, { type: "pr", ref: "acme/web#0" }, "stacked-on");

      expect(await store.queryLinks({ from: t })).toHaveLength(1);
      expect(await store.queryLinks({ from: pr })).toHaveLength(2);
      expect(await store.queryLinks({ to: pr })).toHaveLength(1);
      expect(await store.queryLinks({ from: pr, relation: "stacked-on" })).toHaveLength(1);
      expect(await store.queryLinks({})).toHaveLength(3);

      expect(await store.unlink(t, pr, "implemented-by")).toBe(1);
      expect(await store.unlink(t, pr, "implemented-by")).toBe(0);
      expect(await store.queryLinks({ from: t })).toHaveLength(0);
    });

    it("counts loop-guard entries inside the window only", async () => {
      let t = Date.parse("2030-01-01T00:00:00.000Z");
      await store.close();
      await open({ now: () => new Date(t) });
      const item = await store.enqueue({ person: "ann", kind: "k", title: "t", trigger: "agent" });
      const other = await store.enqueue({ person: "ann", kind: "k", title: "o", trigger: "agent" });
      await store.recordLoopGuard(item.id);
      t += 60_000;
      await store.recordLoopGuard(item.id);
      await store.recordLoopGuard(other.id);
      t += 60_000;
      expect(await store.countLoopGuard(item.id, 10 * 60_000)).toBe(2);
      expect(await store.countLoopGuard(item.id, 90_000)).toBe(1);
      expect(await store.countLoopGuard(item.id, 1_000)).toBe(0);
      expect(await store.countLoopGuard(other.id, 10 * 60_000)).toBe(1);
    });

    it("creates and answers conversations once", async () => {
      const asker = await store.enqueue({ person: "ann", kind: "k", title: "t", trigger: "human" });
      const c = await store.createConversation({
        askerItemId: asker.id,
        target: "bob",
        question: "why?",
        depth: 1,
      });

      expect(c).toMatchObject({ status: "open", answer: null, depth: 1 });
      const answered = await store.answerConversation(c.id, "because");
      expect(answered).toMatchObject({ status: "answered", answer: "because" });
      expect(answered.answeredAt).not.toBeNull();
      expect(await store.getConversation(c.id)).toEqual(answered);
      await expect(store.answerConversation(c.id, "again")).rejects.toThrow(/./);
      await expect(store.answerConversation("missing", "x")).rejects.toThrow(/./);
    });

    it("losing the store only costs a rescan", async () => {
      await store.setCursor("github", "etag", "abc");
      await store.recordEvent({ source: "github", externalId: "1", type: "t", payload: {} });
      await store.close();
      await h.lose();

      await open();
      expect(await store.getCursor("github", "etag")).toBeUndefined();
      // The rescan re-reads the same events and they are accepted again.
      expect(
        await store.recordEvent({ source: "github", externalId: "1", type: "t", payload: {} }),
      ).toBe(true);

      await store.setCursor("github", "etag", "abc");
      expect(await store.getCursor("github", "etag")).toBe("abc");
    });
  });
}

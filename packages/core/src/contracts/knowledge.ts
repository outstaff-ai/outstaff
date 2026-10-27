import { expect, it } from "vitest";
import type { Knowledge } from "#/ports/index.js";
import type { KnowledgeSeed } from "./seeds.js";
import {
  contractSuite,
  expectAbsoluteUrl,
  expectPortError,
  requireCapability,
  requireSeed,
} from "./harness.js";
import type { ContractSetupFn } from "./types.js";

export function knowledgeContract(
  name: string,
  setup: ContractSetupFn<Knowledge, KnowledgeSeed>,
): void {
  contractSuite(`knowledge contract: ${name}`, setup, (get) => {
    it("creates a document readable by id and by path, with an absolute url", async (t) => {
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      const doc = await s.subject.create({
        path: "handbook/start",
        title: "Start",
        body: "Welcome",
      });

      expectAbsoluteUrl(doc.url);
      expect(doc.url).toBe(s.subject.links.doc(doc.id));
      expect((await s.subject.get(doc.id)).body).toBe("Welcome");
      expect((await s.subject.get("handbook/start")).id).toBe(doc.id);
    });

    it("reports not_found and conflict", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      await expectPortError(s.subject.get("missing/doc"), "not_found");
      await s.subject.create({ path: "a/b", title: "T", body: "" });
      await expectPortError(s.subject.create({ path: "a/b", title: "T2", body: "" }), "conflict");
    });

    it("reports forbidden when the platform refuses", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      await expectPortError(requireSeed(t, s.seed, "forbiddenCall")(), "forbidden");
    });

    it("updates a document and rejects a stale baseVersion", async (t) => {
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      const doc = await s.subject.create({ path: "notes/x", title: "X", body: "v1" });
      const updated = await s.subject.update(doc.id, { body: "v2", baseVersion: doc.version });
      expect(updated.body).toBe("v2");
      expect(updated.version).not.toBe(doc.version);
      await expectPortError(
        s.subject.update(doc.id, { body: "v3", baseVersion: doc.version }),
        "conflict",
      );
    });

    it("searches documents", async (t) => {
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      await s.subject.create({ path: "n/one", title: "Rollout plan", body: "" });
      expect((await s.subject.search("rollout")).map((d) => d.path)).toContain("n/one");
      expect(await s.subject.search("no-such-term-xyz")).toEqual([]);
    });

    it("comments, replies and resolves", async (t) => {
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      const doc = await s.subject.create({ path: "n/two", title: "Two", body: "text to anchor" });
      const c = await s.subject.comment(doc.id, { body: "why?", anchorText: "anchor" });
      const r = await s.subject.reply(c.id, "because");
      expect(r.parentId).toBe(c.id);
      expect(s.subject.links.comment?.(doc.id, r.id) ?? "https://").toMatch(/^https?:\/\//);

      await s.subject.resolve(c.id);
      const all = await s.subject.comments(doc.id);
      expect(all.map((x) => x.id)).toEqual(expect.arrayContaining([c.id, r.id]));
      expect(all.find((x) => x.id === c.id)?.resolved).toBe(true);
      await expectPortError(s.subject.resolve("missing-comment"), "not_found");
    });

    it("reports the comments and replies of the named documents after a cursor, oldest first", async (t) => {
      const s = get();
      requireCapability(t, s, "knowledge.docs");
      const doc = await s.subject.create({
        path: "n/three",
        title: "Three",
        body: "text to anchor",
      });

      const other = await s.subject.create({ path: "n/four", title: "Four", body: "other text" });
      const first = await s.subject.events([doc.id, other.id]);
      const c = await s.subject.comment(doc.id, { body: "why?", anchorText: "anchor" });
      const r = await s.subject.reply(c.id, "because");
      await s.subject.comment(other.id, { body: "unrelated", anchorText: "other" });

      const page = await s.subject.events([doc.id], first.cursor);
      expect(page.events.map((e) => e.data.commentId)).toEqual([c.id, r.id]);
      expect(page.events.every((e) => e.doc === doc.id && e.type === "commented")).toBe(true);
      expect(new Set(page.events.map((e) => e.externalId)).size).toBe(2);
      expect(page.events[0]).toMatchObject({
        title: "Three",
        data: { body: "why?", anchorText: "anchor" },
      });

      expect(page.events[1]?.data.parentId).toBe(c.id);
      expectAbsoluteUrl(page.events[0]!.url);
      expect(page.events[0]!.actor.id).not.toBe("");
      const times = page.events.map((e) => Date.parse(e.at));
      expect(times).toEqual(times.toSorted((a, b) => a - b));
    });
  });
}

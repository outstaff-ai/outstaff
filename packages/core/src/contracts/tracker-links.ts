import { describe, expect, it } from "vitest";
import type { Tracker } from "#/ports/index.js";
import { expectPortError, requireCapability } from "./harness.js";
import type { TrackerSeed } from "./seeds.js";
import type { ContractSetup } from "./types.js";

/** Links between issues: made, read back from both ends, and removed. */
export function trackerLinkCases(get: () => ContractSetup<Tracker, TrackerSeed>): void {
  describe("links", () => {
    it("reads the tickets an issue blocks and is blocked by, with their status", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const blocker = await s.subject.createIssue({ title: "Pick the font", body: "" });
      const blocked = await s.subject.createIssue({ title: "Set the font", body: "" });
      const related = await s.subject.createIssue({ title: "Font size", body: "" });
      await s.subject.link(blocker.key, blocked.key, "blocks");
      await s.subject.link(blocker.key, related.key, "relates");
      await s.subject.transition(blocker.key, "done");
      await s.subject.transition(blocked.key, "blocked");

      const from = await s.subject.getIssue(blocker.key);
      expect(from.blocks?.map((l) => [l.key, l.status.canonical])).toEqual([
        [blocked.key, "blocked"],
      ]);

      expect(from.blockedBy).toEqual([]);
      const to = await s.subject.getIssue(blocked.key);
      expect(to.blocks).toEqual([]);
      expect(to.blockedBy?.map((l) => [l.key, l.status.canonical])).toEqual([
        [blocker.key, "done"],
      ]);
    });

    it("links issues and rejects unknown targets", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const a = await s.subject.createIssue({ title: "A", body: "" });
      const b = await s.subject.createIssue({ title: "B", body: "" });
      await expect(s.subject.link(a.key, b.key, "blocks")).resolves.toBeUndefined();
      await expectPortError(s.subject.link(a.key, "NOPE-99999", "relates"), "not_found");
    });

    it("unlinks a blocking link, leaves the other links, and unlinks nothing twice", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const a = await s.subject.createIssue({ title: "Unlink A", body: "" });
      const b = await s.subject.createIssue({ title: "Unlink B", body: "" });
      const c = await s.subject.createIssue({ title: "Unlink C", body: "" });
      await s.subject.link(a.key, b.key, "blocks");
      await s.subject.link(a.key, c.key, "blocks");

      // Only the link as stated: B does not block A.
      await s.subject.unlink(b.key, a.key, "blocks");
      expect((await s.subject.getIssue(b.key)).blockedBy?.map((l) => l.key)).toEqual([a.key]);

      await s.subject.unlink(a.key, b.key, "blocks");
      expect((await s.subject.getIssue(a.key)).blocks?.map((l) => l.key)).toEqual([c.key]);
      expect((await s.subject.getIssue(b.key)).blockedBy).toEqual([]);
      await expect(s.subject.unlink(a.key, b.key, "blocks")).resolves.toBeUndefined();
    });

    it("unlinks a relates link from either end and rejects unknown keys", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const a = await s.subject.createIssue({ title: "Relate A", body: "" });
      const b = await s.subject.createIssue({ title: "Relate B", body: "" });
      await s.subject.link(a.key, b.key, "relates");
      await expect(s.subject.unlink(b.key, a.key, "relates")).resolves.toBeUndefined();
      await expectPortError(s.subject.unlink(a.key, "NOPE-99999", "relates"), "not_found");
      await expectPortError(s.subject.unlink("NOPE-99999", a.key, "blocks"), "not_found");
    });
  });
}

import { describe, expect, it } from "vitest";
import type { Tracker } from "#/ports/index.js";
import { requireCapability } from "./harness.js";
import type { TrackerSeed } from "./seeds.js";
import type { ContractSetup } from "./types.js";

/** Listing issues: by several statuses, by label, a brief listing, and the subtasks of a ticket. */
export function trackerListingCases(get: () => ContractSetup<Tracker, TrackerSeed>): void {
  describe("listing", () => {
    it("lists by any of several statuses, most recently updated first", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const first = await s.subject.createIssue({ title: "List one", body: "" });
      const second = await s.subject.createIssue({ title: "List two", body: "" });
      const third = await s.subject.createIssue({ title: "List three", body: "" });
      await s.subject.transition(second.key, "blocked");
      await s.subject.transition(third.key, "done");
      await s.subject.transition(first.key, "review");

      const keys = (await s.subject.listIssues({ status: ["review", "blocked"] })).map(
        (i) => i.key,
      );

      expect(keys).not.toContain(third.key);
      expect(keys.indexOf(first.key)).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(first.key)).toBeLessThan(keys.indexOf(second.key));
      expect(await s.subject.listIssues({ status: ["review", "blocked"], limit: 1 })).toHaveLength(
        1,
      );
    });

    it("lists by label, and a brief listing still carries what a list shows", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const tagged = await s.subject.createIssue({
        title: "Tagged",
        body: "Long text",
        labels: ["acme-list"],
      });

      await s.subject.createIssue({ title: "Untagged", body: "" });
      const listed = await s.subject.listIssues({ label: "acme-list", brief: true });
      expect(listed.map((i) => i.key)).toEqual([tagged.key]);
      expect(listed[0]).toMatchObject({
        key: tagged.key,
        title: "Tagged",
        labels: ["acme-list"],
        url: tagged.url,
      });

      expect(listed[0]!.status.canonical).toBe("backlog");
      expect(listed[0]!.updatedAt).toBeTruthy();
      expect(await s.subject.listIssues({ label: "no-such-label-xyz" })).toEqual([]);
    });

    it("lists the subtasks of a ticket", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      if (!s.subject.setParent) {
        t.skip();
        return;
      }

      const parent = await s.subject.createIssue({ title: "Parent", body: "" });
      const child = await s.subject.createIssue({ title: "Child", body: "", parent: parent.key });
      await s.subject.createIssue({ title: "Loose", body: "" });
      const keys = (await s.subject.listIssues({ parent: parent.key })).map((i) => i.key);
      expect(keys).toEqual([child.key]);
    });
  });
}

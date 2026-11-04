import { describe, expect, it } from "vitest";
import type { Tracker } from "#/ports/index.js";
import { requireCapability } from "./harness.js";
import type { TrackerSeed } from "./seeds.js";
import type { ContractSetup } from "./types.js";

/** The real parent field: setting a ticket's parent and clearing it again. */
export function trackerParentCases(get: () => ContractSetup<Tracker, TrackerSeed>): void {
  describe("parents", () => {
    it("clears the parent of a sub-ticket", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      if (!s.subject.setParent) {
        t.skip();
        return;
      }

      const parent = await s.subject.createIssue({ title: "Parent to leave", body: "" });
      const child = await s.subject.createIssue({ title: "Leaving child", body: "" });
      await s.subject.setParent(child.key, parent.key);
      expect((await s.subject.getIssue(child.key)).parent).toBe(parent.key);

      await s.subject.setParent(child.key, null);
      expect((await s.subject.getIssue(child.key)).parent).toBeUndefined();
      expect(await s.subject.listIssues({ parent: parent.key })).toEqual([]);
    });

    it("clearing a ticket without a parent changes nothing", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      if (!s.subject.setParent) {
        t.skip();
        return;
      }

      const loose = await s.subject.createIssue({ title: "Never a child", body: "" });
      await s.subject.setParent(loose.key, null);
      expect((await s.subject.getIssue(loose.key)).parent).toBeUndefined();
    });
  });
}

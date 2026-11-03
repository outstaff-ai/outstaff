import { describe, expect, it } from "vitest";
import type { Tracker } from "#/ports/index.js";
import { expectAbsoluteUrl, expectPortError, requireCapability } from "./harness.js";
import type { TrackerSeed } from "./seeds.js";
import type { ContractSetup } from "./types.js";

/** Initiatives (the roadmap's milestones): made, listed, changed, and the tickets in them. */
export function trackerInitiativeCases(get: () => ContractSetup<Tracker, TrackerSeed>): void {
  describe("initiatives", () => {
    it("creates initiatives, reads them back, and lists them by status", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.initiatives");
      const later = await s.subject.createInitiative!({
        title: "Acme monitoring",
        description: "Graphs.",
      });

      const now = await s.subject.createInitiative!({ title: "Acme basics", status: "active" });
      expect(later).toMatchObject({
        title: "Acme monitoring",
        description: "Graphs.",
        status: "planned",
      });

      expect(now.status).toBe("active");
      expectAbsoluteUrl(later.url);
      expect(await s.subject.getInitiative!(later.id)).toMatchObject({
        id: later.id,
        title: later.title,
      });

      const ids = (await s.subject.initiatives!()).map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([later.id, now.id]));
      const active = (await s.subject.initiatives!({ status: ["active"] })).map((i) => i.id);
      expect(active).toContain(now.id);
      expect(active).not.toContain(later.id);
      await expectPortError(s.subject.getInitiative!("999999"), "not_found");
    });

    it("changes the status and title of an initiative, one field at a time", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.initiatives");
      const made = await s.subject.createInitiative!({ title: "Acme phase", status: "active" });
      expect(await s.subject.updateInitiative!(made.id, { status: "done" })).toMatchObject({
        title: "Acme phase",
        status: "done",
      });

      expect(await s.subject.updateInitiative!(made.id, { title: "Acme phase one" })).toMatchObject(
        {
          title: "Acme phase one",
          status: "done",
        },
      );

      await expectPortError(s.subject.updateInitiative!("999999", { status: "done" }), "not_found");
    });

    it("puts tickets in an initiative, lists them, and takes one out", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.initiatives");
      const milestone = await s.subject.createInitiative!({ title: "Acme milestone" });
      const born = await s.subject.createIssue({
        title: "Born in it",
        body: "",
        initiative: milestone.id,
      });

      const moved = await s.subject.createIssue({ title: "Moved in", body: "" });
      expect((await s.subject.getIssue(moved.key)).initiative).toBeNull();
      const put = await s.subject.setInitiative!(moved.key, milestone.id);
      expect(put.initiative).toEqual({ id: milestone.id, title: "Acme milestone" });
      expect((await s.subject.getIssue(born.key)).initiative).toEqual({
        id: milestone.id,
        title: "Acme milestone",
      });

      const keys = (await s.subject.listIssues({ initiative: milestone.id })).map((i) => i.key);
      expect(keys.toSorted()).toEqual([born.key, moved.key].toSorted());

      await s.subject.setInitiative!(moved.key, null);
      expect((await s.subject.getIssue(moved.key)).initiative).toBeNull();
      const left = (await s.subject.listIssues({ initiative: milestone.id })).map((i) => i.key);
      expect(left).toEqual([born.key]);
      await expectPortError(s.subject.setInitiative!("NOPE-99999", milestone.id), "not_found");
      await expectPortError(s.subject.setInitiative!(moved.key, "999999"), "not_found");
    });
  });
}

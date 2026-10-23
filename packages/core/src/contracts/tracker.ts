import { expect, it } from "vitest";
import type { Tracker } from "../ports/index.js";
import type { TrackerSeed } from "./seeds.js";
import {
  contractSuite,
  expectAbsoluteUrl,
  expectEventCursorBehaviour,
  expectPortError,
  requireCapability,
  requireSeed,
  type ContractSetupFn,
} from "./harness.js";

export function trackerContract(name: string, setup: ContractSetupFn<Tracker, TrackerSeed>): void {
  contractSuite(`tracker contract: ${name}`, setup, (get) => {
    it("creates an issue that can be read back with an absolute url", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const created = await s.subject.createIssue({
        title: "Fix login",
        body: "Steps to reproduce",
        labels: ["bug"],
      });

      expect(created.key).toBeTruthy();
      expect(created.labels).toEqual(["bug"]);
      expectAbsoluteUrl(created.url);
      expect(created.url).toBe(s.subject.links.issue(created.key));
      expect(await s.subject.getIssue(created.key)).toMatchObject({
        key: created.key,
        title: "Fix login",
        body: "Steps to reproduce",
      });
    });

    it("reports not_found for an unknown key", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "tracker.issues");
      await expectPortError(s.subject.getIssue("NOPE-99999"), "not_found");
      await expectPortError(s.subject.transition("NOPE-99999", "done"), "not_found");
      await expectPortError(s.subject.comment("NOPE-99999", "hi"), "not_found");
    });

    it("reports forbidden when the platform refuses", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "tracker.issues");
      await expectPortError(requireSeed(t, s.seed, "forbiddenCall")(), "forbidden");
    });

    it("transitions to a canonical status and filters by it", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const issue = await s.subject.createIssue({ title: "Move me", body: "" });
      const moved = await s.subject.transition(issue.key, "review");
      expect(moved.status.canonical).toBe("review");
      const listed = await s.subject.listIssues({ status: "review" });
      expect(listed.map((i) => i.key)).toContain(issue.key);
      const other = await s.subject.listIssues({ status: "canceled" });
      expect(other.map((i) => i.key)).not.toContain(issue.key);
    });

    it("searches by title and honours the limit", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      await s.subject.createIssue({ title: "Zebra crossing", body: "" });
      await s.subject.createIssue({ title: "Zebra stripes", body: "" });
      expect((await s.subject.search("zebra")).length).toBeGreaterThanOrEqual(2);
      expect((await s.subject.search("zebra", 1)).length).toBe(1);
    });

    it("adds and removes labels", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const issue = await s.subject.createIssue({
        title: "Label me",
        body: "",
        labels: ["a", "b"],
      });

      const updated = await s.subject.setLabels(issue.key, ["c"], ["a"]);
      expect([...updated.labels].toSorted()).toEqual(["b", "c"]);
    });

    it("comments and lists comments in order", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const issue = await s.subject.createIssue({ title: "Talk", body: "" });
      const first = await s.subject.comment(issue.key, "one");
      await s.subject.comment(issue.key, "two");
      expectAbsoluteUrl(first.url);
      const comments = await s.subject.listComments(issue.key);
      expect(comments.map((c) => c.body)).toEqual(["one", "two"]);
    });

    it("links issues and rejects unknown targets", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const a = await s.subject.createIssue({ title: "A", body: "" });
      const b = await s.subject.createIssue({ title: "B", body: "" });
      await expect(s.subject.link(a.key, b.key, "blocks")).resolves.toBeUndefined();
      await expectPortError(s.subject.link(a.key, "NOPE-99999", "relates"), "not_found");
    });

    it("assigns and unassigns a member", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.assign");
      const member = await requireSeed(t, s.seed, "member")({ name: "Noor" });
      expect((await s.subject.members()).map((m) => m.id)).toContain(member.id);
      const issue = await s.subject.createIssue({ title: "Own it", body: "" });
      expect((await s.subject.assign(issue.key, member.id)).assignee?.id).toBe(member.id);
      expect((await s.subject.listIssues({ assignee: member.id })).map((i) => i.key)).toContain(
        issue.key,
      );

      expect((await s.subject.assign(issue.key, null)).assignee).toBeUndefined();
    });

    it("pages events with an opaque cursor and no duplicates", async (t) => {
      expect.hasAssertions();
      const s = get();
      requireCapability(t, s, "tracker.issues");
      const issue = await s.subject.createIssue({ title: "Watch", body: "" });
      await expectEventCursorBehaviour(
        (cursor) => s.subject.events(cursor),
        async () => {
          await s.subject.comment(issue.key, "ping");
        },
      );
    });
  });
}

import { expect, it } from "vitest";
import type { Tracker } from "#/ports/index.js";
import type { TrackerSeed } from "./seeds.js";
import {
  contractSuite,
  expectAbsoluteUrl,
  expectEventCursorBehaviour,
  expectPortError,
  requireCapability,
  requireSeed,
} from "./harness.js";
import type { ContractSetupFn } from "./types.js";

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

    it("attaches a file to an issue and rejects an unknown key", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.attachments");
      expect(s.subject.attach).toBeTypeOf("function");
      const issue = await s.subject.createIssue({ title: "With a picture", body: "" });
      const file = { name: "screen.png", mimetype: "image/png", data: new Uint8Array([1, 2, 3]) };
      await expect(s.subject.attach!(issue.key, file)).resolves.toBeUndefined();
      await expectPortError(s.subject.attach!("NOPE-99999", file), "not_found");
    });

    it("lists the files attached to an issue and downloads their bytes", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.attachments");
      expect(s.subject.attachments).toBeTypeOf("function");
      expect(s.subject.download).toBeTypeOf("function");
      const issue = await s.subject.createIssue({ title: "Screenshot attached", body: "" });
      expect(await s.subject.attachments!(issue.key)).toEqual([]);
      const data = new Uint8Array([9, 8, 7, 6]);
      await s.subject.attach!(issue.key, { name: "bug.png", mimetype: "image/png", data });
      const listed = await s.subject.attachments!(issue.key);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ name: "bug.png", mimetype: "image/png", size: 4 });
      expect([...(await s.subject.download!(listed[0]!))]).toEqual([...data]);
      await expectPortError(s.subject.attachments!("NOPE-99999"), "not_found");
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
      const link = s.subject.links.comment?.(issue.key, first.id) ?? first.url;
      expectAbsoluteUrl(link);
      expect(first.url).toBe(link);

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

    it("creates an issue already assigned to a member", async (t) => {
      const s = get();
      requireCapability(t, s, "tracker.issues", "tracker.assign");
      const member = await requireSeed(t, s.seed, "member")({ name: "Noor" });
      const created = await s.subject.createIssue({
        title: "Born assigned",
        body: "",
        assignee: member.id,
      });

      expect(created.assignee?.id).toBe(member.id);
      expect((await s.subject.getIssue(created.key)).assignee?.id).toBe(member.id);
      expect((await s.subject.listIssues({ assignee: member.id })).map((i) => i.key)).toContain(
        created.key,
      );
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

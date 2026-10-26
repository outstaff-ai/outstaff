import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import type { FakeTracker, FakeVcs } from "@outstaff/core/fakes";
import type { PrRef, WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock, type ManualClock } from "../clock.js";
import { createIntake } from "../intake/index.js";
import { REPO, teamConfig } from "../intake/test-support.js";
import { openStore } from "../store/open.js";
import type { Store } from "../store/types.js";
import { createWorkState, formatCurrentWork } from "./workstate.js";
import type { WorkState, WorkstateMeta } from "./types.js";

const SAM = "acme-sam[bot]";
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const pgUrl = process.env["OUTSTAFF_TEST_POSTGRES_URL"] ?? "";

interface Harness {
  open(now: () => Date): Promise<Store>;
  cleanup(): Promise<void>;
}

const harnesses: [string, () => Harness][] = [
  [
    "sqlite",
    () => ({ open: (now) => openStore("sqlite::memory:", { now }), cleanup: async () => {} }),
  ],
];

if (pgUrl) {
  harnesses.push([
    "postgres",
    () => {
      const schema = `t_${randomUUID().replaceAll("-", "")}`;
      return {
        open: (now) => openStore(pgUrl, { now, schema }),
        cleanup: async () => {
          const c = new Client({ connectionString: pgUrl });
          await c.connect();
          try {
            await c.query(`drop schema if exists "${schema}" cascade`);
          } finally {
            await c.end();
          }
        },
      };
    },
  ]);
}

const prRef = (number: number): PrRef => ({ repo: REPO, number });
const prEvent = (
  type: WorkflowEvent["type"],
  number: number,
  data: Record<string, unknown> = {},
  actor: WorkflowEvent["actor"] = { kind: "human", id: "dana" },
): WorkflowEvent => ({ type, subject: { pr: prRef(number) }, actor, data });

const ticketEvent = (
  type: WorkflowEvent["type"],
  key: string,
  actor: WorkflowEvent["actor"] = { kind: "human", id: "dana" },
  data: Record<string, unknown> = {},
): WorkflowEvent => ({ type, subject: { ticket: key }, actor, data });

const meta = (id = "e"): WorkstateMeta => ({ source: "vcs", externalId: id, trusted: true });

describe.each(harnesses)("work state on %s", (_name, makeHarness) => {
  let h: Harness;
  let clock: ManualClock;
  let store: Store;
  let vcs: FakeVcs;
  let tracker: FakeTracker;
  let ws: WorkState;
  let seen: WorkflowEvent[];

  const open = (extra: { mergeableRetries?: number } = {}) => {
    vcs = createFakeVcs({ now: clock.now, ...extra });
    tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-sam", name: "Sam", kind: "agent" },
    });
  };

  const build = async (team = teamConfig()) => {
    ws = await createWorkState({
      store,
      ports: { vcs, tracker },
      team,
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  };

  const pr = (over: Parameters<FakeVcs["seed"]["pullRequest"]>[1]) =>
    vcs.seed.pullRequest(REPO, { author: { login: SAM, kind: "agent" }, ...over });

  beforeEach(async () => {
    h = makeHarness();
    clock = manualClock();
    store = await h.open(() => clock.now());
    seen = [];
    open();
    await build();
  });

  afterEach(async () => {
    await ws.stop();
    await store.close().catch(() => undefined);
    await h.cleanup();
  });

  const types = () => seen.map((e) => `${e.type}#${e.subject.pr?.number}`);

  describe("links", () => {
    it("links a pull request to the ticket named in its branch and to its author", async () => {
      const issue = await tracker.createIssue({ title: "Search", body: "", assignee: "u-sam" });
      const p = await pr({
        title: "Add search",
        head: { ref: `sam/${issue.key.toLowerCase()}-search` },
      });

      await ws.apply(prEvent("pr.opened", p.number), meta());

      const key = ws.prSubject(prRef(p.number));
      expect(ws.ticketForPr(prRef(p.number))).toBe(issue.key);
      expect(ws.pullRequest(prRef(p.number))?.author).toEqual({
        login: SAM,
        kind: "agent",
        person: "sam",
      });

      expect(await store.queryLinks({ from: { type: "pr", ref: key } })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "implements",
            to: { type: "ticket", ref: issue.key },
          }),
          expect.objectContaining({ relation: "authored_by", to: { type: "person", ref: "sam" } }),
        ]),
      );

      expect((await store.getSubject("pr", key))?.data).toMatchObject({
        ticket: issue.key,
        headRef: p.head.ref,
      });
    });

    it("uses a closing reference in the body and the title, and skips keys the tracker does not know", async () => {
      const a = await tracker.createIssue({ title: "A", body: "" });
      const b = await tracker.createIssue({ title: "B", body: "" });
      const first = await pr({ title: "Use SHA-256", body: `Closes ${a.key}` });
      const second = await pr({ title: `${b.key}: tweak` });
      const third = await pr({ title: "Use SHA-256" });
      for (const n of [first.number, second.number, third.number]) {
        await ws.apply(prEvent("pr.opened", n), meta());
      }

      expect(ws.ticketForPr(prRef(first.number))).toBe(a.key);
      expect(ws.ticketForPr(prRef(second.number))).toBe(b.key);
      expect(ws.ticketForPr(prRef(third.number))).toBeUndefined();
    });

    it("does not link a pull request that only mentions a ticket, and merging it leaves the ticket alone", async () => {
      const a = await tracker.createIssue({ title: "A", body: "" });
      const p = await pr({
        title: "Retry docs",
        body: `After deploying, ask the agent to retry ${a.key}.`,
      });

      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.merge(REPO, p.number, "dana");
      await ws.apply(prEvent("pr.merged", p.number), meta());

      expect(ws.ticketForPr(prRef(p.number))).toBeUndefined();
      expect(ws.prsOfTicket(a.key)).toEqual([]);
    });

    it("tells which ticket a pull request about to be opened links to, and what that ticket has", async () => {
      const a = await tracker.createIssue({ title: "A", body: "" });
      const b = await tracker.createIssue({ title: "B", body: "" });
      const p = await pr({ title: `${a.key}: index`, head: { ref: "sam/index" } });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.merge(REPO, p.number, "dana");
      await ws.apply(prEvent("pr.merged", p.number), meta());

      // By the rule that links existing ones: the branch outranks a closing keyword in the body.
      const draft = {
        headRef: `sam/${a.key.toLowerCase()}-ui`,
        title: "ui",
        body: `Closes ${b.key}`,
      };

      expect(await ws.ticketForDraft(draft)).toBe(a.key);
      expect(await ws.ticketForDraft({ ...draft, headRef: "sam/ui" })).toBe(b.key);
      expect(await ws.ticketForDraft({ ...draft, headRef: "sam/ui", body: `See ${b.key}` })).toBe(
        undefined,
      );

      expect(await ws.ticketForDraft({ headRef: "sam/ui", title: "ui", body: "" })).toBeUndefined();
      expect(await ws.ticketForDraft({ headRef: "sam/ui", title: "SHOP-77: ui", body: "" })).toBe(
        undefined,
      );

      expect(ws.prsOfTicket(a.key).map((r) => [r.ref.number, r.state])).toEqual([
        [p.number, "merged"],
      ]);

      expect(ws.prsOfTicket(b.key)).toEqual([]);
      expect(ws.pullRequestsOf(a.key).map((r) => r.state)).toEqual(["merged"]);
    });

    it("takes in an open pull request whose event has not arrived, without raising events", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "" });
      const p = await pr({
        title: `${issue.key}: index`,
        head: { ref: "sam/index" },
        mergeable: ["conflicting"],
      });

      expect(ws.prsOfTicket(issue.key)).toEqual([]);
      await ws.catchUp();
      expect(ws.prsOfTicket(issue.key).map((r) => r.ref.number)).toEqual([p.number]);
      expect(seen).toEqual([]);

      // What it knows is left as it is.
      const before = ws.pullRequest(prRef(p.number));
      await ws.catchUp();
      expect(ws.pullRequest(prRef(p.number))).toEqual(before);
    });

    it("knows a ticket was handed back as done while its latest work item is done", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "" });
      const item = await store.enqueue({
        person: "sam",
        kind: "assigned",
        title: "assigned",
        trigger: "human",
        subject: { type: "ticket", ref: issue.key },
      });

      await store.updateItem(item.id, { status: "active" });
      await ws.refreshWorkers();
      expect(ws.handedBack(issue.key)).toBe(false);
      await store.updateItem(item.id, { status: "done" });
      await ws.refreshWorkers();
      expect(ws.handedBack(issue.key)).toBe(true);

      clock.advance(1000);
      const later = await store.enqueue({
        person: "sam",
        kind: "review_feedback",
        title: "feedback",
        trigger: "human",
        subject: { type: "ticket", ref: issue.key },
      });

      await store.updateItem(later.id, { status: "active" });
      await ws.refreshWorkers();
      expect(ws.handedBack(issue.key)).toBe(false);
    });

    it("links the ticket assignee to the person", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "", assignee: "u-sam" });
      await ws.apply(ticketEvent("ticket.assigned", issue.key), meta());
      expect(ws.assignee(issue.key)).toEqual({ id: "sam", kind: "agent" });
      expect(await store.queryLinks({ from: { type: "ticket", ref: issue.key } })).toEqual([
        expect.objectContaining({ relation: "assigned_to", to: { type: "person", ref: "sam" } }),
      ]);
    });
  });

  describe("stacks", () => {
    it("detects pull requests stacked on another open one, bottom first", async () => {
      const a = await pr({ title: "a", head: { ref: "feat/a" } });
      const c = await pr({ title: "c", head: { ref: "feat/c" }, base: { ref: "feat/b" } });
      const b = await pr({ title: "b", head: { ref: "feat/b" }, base: { ref: "feat/a" } });
      for (const n of [a.number, c.number, b.number]) {
        await ws.apply(prEvent("pr.opened", n), meta());
      }

      expect(ws.stackedOn(REPO, "feat/a").map((p) => p.ref.number)).toEqual([b.number, c.number]);
      expect(ws.stackedOn(REPO, "feat/b").map((p) => p.ref.number)).toEqual([c.number]);
      expect(ws.stackedOn(REPO, "feat/c")).toEqual([]);
      expect(await store.queryLinks({ relation: "stacked_on" })).toHaveLength(2);
      expect(
        await store.queryLinks({
          to: { type: "pr", ref: ws.prSubject(prRef(a.number)) },
          relation: "stacked_on",
        }),
      ).toEqual([expect.objectContaining({ relation: "stacked_on" })]);
    });

    it("drops the stack link when the base pull request is merged", async () => {
      const a = await pr({ title: "a", head: { ref: "feat/a" } });
      const b = await pr({ title: "b", head: { ref: "feat/b" }, base: { ref: "feat/a" } });
      await ws.apply(prEvent("pr.opened", a.number), meta());
      await ws.apply(prEvent("pr.opened", b.number), meta());
      await vcs.seed.merge(REPO, a.number, "dana");
      await ws.apply(prEvent("pr.merged", a.number), meta());

      expect(ws.stackedOn(REPO, "feat/a").map((p) => p.ref.number)).toEqual([b.number]);
      expect(await store.queryLinks({ relation: "stacked_on" })).toEqual([]);
    });
  });

  describe("conflicts", () => {
    it("emits pr.conflicted for open pull requests that conflict after a merge", async () => {
      const merged = await pr({ title: "m" });
      const clean = await pr({ title: "clean", mergeable: ["clean"] });
      const hit = await pr({ title: "hit", mergeable: ["clean", "conflicting"] });
      for (const n of [merged.number, clean.number, hit.number]) {
        await ws.apply(prEvent("pr.opened", n), meta());
      }

      expect(seen).toEqual([]);
      await vcs.seed.merge(REPO, merged.number, "dana");
      await ws.apply(prEvent("pr.merged", merged.number), meta());

      expect(types()).toEqual([`pr.conflicted#${hit.number}`]);
      const event = seen[0]!;
      expect(event.actor).toEqual({ kind: "automation", id: "workstate" });
      expect(event.data).toMatchObject({ sha: hit.head.sha, base: "main" });
      expect(ws.pullRequest(prRef(hit.number))).toBeDefined();
    });

    it("waits for unknown mergeability, and catches it later when it stays unknown", async () => {
      const merged = await pr({ title: "m" });
      const waits = await pr({
        title: "waits",
        mergeable: ["clean", "unknown", "unknown", "conflicting"],
      });

      for (const n of [merged.number, waits.number]) {
        await ws.apply(prEvent("pr.opened", n), meta());
      }

      await vcs.seed.merge(REPO, merged.number, "dana");
      await ws.apply(prEvent("pr.merged", merged.number), meta());
      expect(types()).toEqual([`pr.conflicted#${waits.number}`]);
    });

    it("emits when unknown becomes known conflicting on a later rescan", async () => {
      await ws.stop();
      open({ mergeableRetries: 1 });
      await build();
      const merged = await pr({ title: "m" });
      const late = await pr({
        title: "late",
        mergeable: ["clean", "unknown", "unknown", "conflicting"],
      });

      for (const n of [merged.number, late.number]) {
        await ws.apply(prEvent("pr.opened", n), meta());
      }

      await vcs.seed.merge(REPO, merged.number, "dana");
      await ws.apply(prEvent("pr.merged", merged.number), meta());
      expect(seen).toEqual([]);

      await ws.rescan();
      expect(types()).toEqual([`pr.conflicted#${late.number}`]);

      await ws.rescan();
      expect(seen).toHaveLength(1);
    });

    it("does not report the same conflict twice for one head commit", async () => {
      const merged = await pr({ title: "m" });
      const hit = await pr({ title: "hit", mergeable: ["clean", "conflicting"] });
      await ws.apply(prEvent("pr.opened", merged.number), meta());
      await ws.apply(prEvent("pr.opened", hit.number), meta());
      await vcs.seed.merge(REPO, merged.number, "dana");
      await ws.apply(prEvent("pr.merged", merged.number), meta());
      await ws.apply(prEvent("pr.merged", merged.number), meta("again"));
      await ws.rescan();
      expect(seen).toHaveLength(1);
    });
  });

  describe("checks", () => {
    it("emits pr.ci_failed once when checks turn to failure", async () => {
      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "pending" });
      await ws.apply(prEvent("pr.comment", p.number), meta());
      expect(seen).toEqual([]);
      expect(ws.pullRequest(prRef(p.number))).toBeDefined();

      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      await ws.apply(prEvent("pr.comment", p.number), meta());
      expect(types()).toEqual([`pr.ci_failed#${p.number}`]);
      expect(seen[0]!.data).toMatchObject({ failing: ["build"], sha: p.head.sha });

      await ws.rescan();
      await ws.apply(prEvent("pr.comment", p.number), meta());
      expect(seen).toHaveLength(1);
    });

    it("reports a new failure after a push, and sees failures through a rescan", async () => {
      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      await ws.rescan();
      expect(seen).toHaveLength(1);

      const pushed = await vcs.seed.push(REPO, p.number, SAM);
      await vcs.seed.check(REPO, pushed.head.sha, { name: "build", status: "success" });
      await ws.rescan();
      await vcs.seed.check(REPO, pushed.head.sha, { name: "build", status: "failure" });
      await ws.rescan();
      expect(seen.map((e) => e.data["sha"])).toEqual([p.head.sha, pushed.head.sha]);
    });

    it("polls on the clock once started", async () => {
      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await ws.start();
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      clock.advance(60_000);
      await ws.stop();
      await ws.rescan();
      expect(seen).toHaveLength(1);
    });

    it("keeps a synthetic event unprocessed when the handler fails", async () => {
      ws.onEvent(() => {
        throw new Error("engine down");
      });

      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      await ws.rescan();
      const left = await store.listUnprocessed();
      expect(left.map((e) => [e.source, e.type])).toEqual([["workstate", "pr.ci_failed"]]);
    });

    it("marks a delivered synthetic event processed", async () => {
      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      await ws.rescan();
      expect(await store.listUnprocessed()).toEqual([]);
    });
  });

  describe("apply", () => {
    it("is idempotent", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "" });
      const p = await pr({ title: `${issue.key} x` });
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      const events = [prEvent("pr.opened", p.number), ticketEvent("ticket.created", issue.key)];
      for (let i = 0; i < 3; i++) {
        for (const e of events) {
          await ws.apply(e, meta());
        }
      }

      expect(seen).toHaveLength(1);
      expect(await store.queryLinks({ relation: "implements" })).toHaveLength(1);
      expect(await store.queryLinks({ from: { type: "workstate", ref: "index" } })).toHaveLength(2);
    });

    it("ignores events it does not track, including its own", async () => {
      await ws.apply(prEvent("pr.conflicted", 99), meta());
      await ws.apply(
        { type: "schedule.cron", subject: {}, actor: { kind: "automation", id: "x" }, data: {} },
        meta(),
      );

      await ws.apply(prEvent("pr.opened", 404), meta());
      expect(ws.pullRequest(prRef(404))).toBeUndefined();
    });

    it("works as an intake handler end to end", async () => {
      const intake = createIntake({
        store,
        ports: { vcs, tracker },
        team: teamConfig(),
        clock,
        logger: silent,
      });

      intake.onEvent((e, m) => ws.apply(e, m));
      await intake.pollOnce();
      await vcs.seed.permission(REPO, "dana", "write");
      const merged = await pr({ title: "m" });
      const hit = await pr({ title: "hit", mergeable: ["clean", "conflicting"] });
      await intake.pollOnce();
      await vcs.seed.merge(REPO, merged.number, "dana");
      await intake.pollOnce();
      expect(types()).toEqual([`pr.conflicted#${hit.number}`]);
      expect(await store.listUnprocessed()).toEqual([]);
    });
  });

  describe("WorkflowState", () => {
    it("answers ticket queries", async () => {
      const issue = await tracker.createIssue({
        title: "A",
        body: "",
        status: "active",
        assignee: "u-sam",
        labels: ["needs-human"],
      });

      await ws.apply(ticketEvent("ticket.created", issue.key), meta());
      expect(ws.ticketStatus(issue.key)).toBe("active");
      expect(ws.assignee(issue.key)).toEqual({ id: "sam", kind: "agent" });
      expect(ws.hasLabel(issue.key, "needs-human")).toBe(true);
      expect(ws.hasLabel(issue.key, "other")).toBe(false);
      expect(ws.requester(issue.key)).toBe("dana");
      expect(ws.ticketStatus("ACME-404")).toBeUndefined();

      await tracker.transition(issue.key, "review");
      await ws.apply(ticketEvent("ticket.moved", issue.key, { kind: "agent", id: "sam" }), meta());
      expect(ws.ticketStatus(issue.key)).toBe("review");
      expect(ws.requester(issue.key)).toBe("dana");
    });

    it("takes the trusted human whose review sends a ticket back for the requester, mapped to their tracker identity", async () => {
      await ws.stop();
      await build(
        teamConfig({
          humans: [{ name: "Grace", identities: { vcs: "Grace-Hopper", tracker: "grace.h" } }],
        }),
      );

      // A ticket from before the office's store: nobody ever recorded a requester.
      const issue = await tracker.createIssue({ title: "A", body: "", status: "review" });
      const p = await pr({ title: "a", head: { ref: `sam/${issue.key}` } });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      expect(ws.ticketStatus(issue.key)).toBe("review");
      expect(ws.requester(issue.key)).toBeUndefined();

      // Not from an untrusted human, and a bare approval is a sign-off, not feedback.
      await ws.apply(
        prEvent("pr.comment", p.number, { untrusted: true }, { kind: "human", id: "eve" }),
        meta("c1"),
      );

      await ws.apply(
        prEvent(
          "pr.review_submitted",
          p.number,
          { state: "approved" },
          { kind: "human", id: "bob" },
        ),
        meta("c2"),
      );

      expect(ws.requester(issue.key)).toBeUndefined();

      await ws.apply(
        prEvent(
          "pr.review_submitted",
          p.number,
          { state: "changes_requested", body: "Fix it" },
          { kind: "human", id: "grace-hopper" },
        ),
        meta("c3"),
      );

      expect(ws.requester(issue.key)).toBe("grace.h");
    });

    it("ignores feedback on a ticket that is not waiting for review", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "", status: "active" });
      const p = await pr({ title: "a", head: { ref: `sam/${issue.key}` } });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await ws.apply(prEvent("pr.comment", p.number, { body: "hm" }), meta("c1"));
      expect(ws.requester(issue.key)).toBeUndefined();
    });

    it("replaces the requester with the latest trusted human to assign or send back, by time", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "" });
      const at = (s: number) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString() });
      const by = (id: string): WorkflowEvent["actor"] => ({ kind: "human", id });
      await ws.apply(ticketEvent("ticket.created", issue.key, by("dana"), at(10)), meta());
      expect(ws.requester(issue.key)).toBe("dana");

      await ws.apply(ticketEvent("ticket.assigned", issue.key, by("grace"), at(20)), meta("e2"));
      expect(ws.requester(issue.key)).toBe("grace");

      // Delivered late: it happened before, so it does not take over.
      await ws.apply(ticketEvent("ticket.assigned", issue.key, by("ada"), at(15)), meta("e3"));
      expect(ws.requester(issue.key)).toBe("grace");

      // A later send-back through the pull request replaces the assigner.
      await tracker.transition(issue.key, "review");
      await ws.apply(
        ticketEvent("ticket.moved", issue.key, { kind: "agent", id: "sam" }),
        meta("e6"),
      );

      const p = await pr({ title: "a", head: { ref: `sam/${issue.key}` } });
      await ws.apply(prEvent("pr.opened", p.number), meta("e4"));
      await ws.apply(
        prEvent("pr.comment", p.number, { body: "again", ...at(30) }, by("dana")),
        meta("e5"),
      );

      expect(ws.requester(issue.key)).toBe("dana");
    });

    it("does not take an untrusted human or an agent for the requester", async () => {
      const a = await tracker.createIssue({ title: "A", body: "" });
      const b = await tracker.createIssue({ title: "B", body: "" });
      await ws.apply(
        ticketEvent("ticket.created", a.key, { kind: "human", id: "eve" }, { untrusted: true }),
        meta(),
      );

      await ws.apply(ticketEvent("ticket.created", b.key, { kind: "agent", id: "sam" }), meta());
      expect(ws.requester(a.key)).toBeUndefined();
      expect(ws.requester(b.key)).toBeUndefined();
    });

    it("finds the last worker from the work item history", async () => {
      const issue = await tracker.createIssue({ title: "A", body: "" });
      const p = await pr({ title: `${issue.key} x` });
      await ws.apply(ticketEvent("ticket.created", issue.key), meta());
      await ws.apply(prEvent("pr.opened", p.number), meta());
      expect(ws.lastWorker(issue.key)).toBeUndefined();

      const first = await store.enqueue({
        person: "sam",
        kind: "task",
        title: "build",
        trigger: "human",
        subject: { type: "ticket", ref: issue.key },
      });

      await store.updateItem(first.id, { status: "done" });
      clock.advance(1000);
      const second = await store.enqueue({
        person: "noor",
        kind: "review",
        title: "review",
        trigger: "agent",
        subject: { type: "pr", ref: ws.prSubject(prRef(p.number)) },
      });

      await ws.refreshWorkers();
      expect(ws.lastWorker(issue.key)).toBe("sam");
      await store.updateItem(second.id, { status: "active" });
      await ws.apply(prEvent("pr.comment", p.number), meta());
      expect(ws.lastWorker(issue.key)).toBe("noor");
    });

    it("resolves roles only when exactly one person plays them", () => {
      expect(ws.personForRole("developer")).toBe("sam");
      expect(ws.personForRole("reviewer")).toBe("noor");
      expect(ws.personForRole("designer")).toBeUndefined();
    });
  });

  describe("currentWork", () => {
    it("summarizes a person's tickets and pull requests", async () => {
      const issue = await tracker.createIssue({
        title: "Search",
        body: "",
        status: "active",
        assignee: "u-sam",
      });

      await tracker.createIssue({ title: "Other", body: "" });
      const mine = await pr({ title: "Add search", head: { ref: `sam/${issue.key}` } });
      const done = await pr({ title: "old" });
      await vcs.seed.thread(REPO, mine.number, { comments: [{ author: "dana", body: "fix" }] });
      await vcs.seed.check(REPO, mine.head.sha, { name: "build", status: "failure" });
      await vcs.seed.review(REPO, mine.number, "dana", "changes_requested");
      await ws.apply(ticketEvent("ticket.assigned", issue.key), meta());
      await ws.apply(prEvent("pr.opened", mine.number), meta());
      await ws.apply(prEvent("pr.opened", done.number), meta());
      await vcs.seed.close(REPO, done.number, "dana");
      await ws.apply(prEvent("pr.closed", done.number), meta());
      await ws.apply(
        prEvent("pr.review_submitted", mine.number, { state: "changes_requested" }),
        meta(),
      );

      const work = ws.currentWork("sam");
      expect(work.tickets).toEqual([
        {
          key: issue.key,
          title: "Search",
          status: "active",
          prs: [ws.prSubject(prRef(mine.number))],
        },
      ]);

      expect(work.prs).toEqual([
        expect.objectContaining({
          number: mine.number,
          ci: "failure",
          unresolvedThreads: 1,
          review: "changes_requested",
          ticket: issue.key,
        }),
      ]);

      const text = formatCurrentWork(work);
      expect(text).toContain(`Ticket ${issue.key} (active): Search`);
      expect(text).toContain("CI failure");
      expect(text).toContain("1 unresolved threads");
      expect(formatCurrentWork(ws.currentWork("noor"))).toBe(
        "noor has no open tickets or pull requests.",
      );
    });
  });

  describe("restart and rescan", () => {
    it("rebuilds from the store", async () => {
      const issue = await tracker.createIssue({
        title: "A",
        body: "",
        status: "active",
        assignee: "u-sam",
      });

      const a = await pr({ title: "a", head: { ref: `sam/${issue.key}` } });
      const b = await pr({ title: "b", head: { ref: "feat/b" }, base: { ref: a.head.ref } });
      await ws.apply(ticketEvent("ticket.created", issue.key), meta());
      await ws.apply(prEvent("pr.opened", a.number), meta());
      await ws.apply(prEvent("pr.opened", b.number), meta());
      await ws.stop();

      // Nothing reachable through the ports: everything comes from the store.
      open();
      await build();
      expect(ws.ticketForPr(prRef(a.number))).toBe(issue.key);
      expect(ws.ticketStatus(issue.key)).toBe("active");
      expect(ws.requester(issue.key)).toBe("dana");
      expect(ws.stackedOn(REPO, a.head.ref).map((p) => p.ref.number)).toEqual([b.number]);
      expect(ws.currentWork("sam").tickets).toHaveLength(1);
    });

    it("rebuilds an empty state by rescanning, without raising events for what was already there", async () => {
      const issue = await tracker.createIssue({
        title: "A",
        body: "",
        status: "active",
        assignee: "u-sam",
      });

      const p = await pr({ title: `${issue.key} x`, mergeable: ["conflicting"] });
      await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
      await ws.stop();

      store = await h.open(() => clock.now());
      await build();
      expect(ws.ticketForPr(prRef(p.number))).toBeUndefined();
      await ws.rescan();
      expect(ws.ticketForPr(prRef(p.number))).toBe(issue.key);
      expect(ws.assignee(issue.key)).toEqual({ id: "sam", kind: "agent" });
      expect(seen).toEqual([]);
    });

    it("notices a pull request merged while nobody was watching", async () => {
      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.merge(REPO, p.number, "dana");
      await ws.rescan();
      expect(ws.currentWork("sam").prs).toEqual([]);
      expect(ws.stackedOn(REPO, "main")).toEqual([]);
    });

    it("forgets finished work after the retention period", async () => {
      await ws.stop();
      ws = await createWorkState({
        store,
        ports: { vcs, tracker },
        team: teamConfig(),
        clock,
        logger: silent,
        retentionMs: 1000,
      });

      const p = await pr({ title: "p" });
      await ws.apply(prEvent("pr.opened", p.number), meta());
      await vcs.seed.merge(REPO, p.number, "dana");
      await ws.apply(prEvent("pr.merged", p.number), meta());
      expect(ws.pullRequest(prRef(p.number))).toBeDefined();
      clock.advance(5000);
      await ws.rescan();
      expect(ws.pullRequest(prRef(p.number))).toBeUndefined();
    });
  });
});

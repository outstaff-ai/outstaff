import {
  createFakeTracker,
  createFakeVcs,
  type FakeTracker,
  type FakeVcs,
} from "@outstaff/core/fakes";
import type { CanonicalStatus, WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { everyMs } from "#/workstate/sweep.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const DANA = { kind: "human" as const, id: "dana" };
const HOUR = 60 * 60 * 1000;

describe("everyMs", () => {
  it("reads minutes and hours, fractions too, and nothing for off", () => {
    expect(everyMs("2h")).toBe(2 * HOUR);
    expect(everyMs("0.5m")).toBe(30_000);
    expect(everyMs("off")).toBeUndefined();
  });
});

describe("work state: the board sweep", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let vcs: FakeVcs;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  let n = 0;

  const build = async (reconcile: Record<string, unknown> = {}) => {
    ws = await createWorkState({
      store,
      ports: { vcs, tracker },
      team: teamConfig({
        policies: {
          merge_checks: { wait_for_start_minutes: 1, settle_minutes: 0 },
          reconcile: { every: "1h", stale_hours: 48, ...reconcile },
        },
      }),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  };

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({ now: clock.now });
    vcs = createFakeVcs({ now: clock.now });
    seen = [];
    await build();
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const apply = (event: Omit<WorkflowEvent, "actor">) =>
    ws.apply(
      { actor: DANA, ...event },
      { source: "tracker", externalId: `e${++n}`, trusted: true },
    );

  const moved = (key: string) =>
    apply({ type: "ticket.moved", subject: { ticket: key }, data: {} });

  const ticket = async (title: string, status: CanonicalStatus, assignee?: string) => {
    const { key } = await tracker.createIssue({ title, body: "", status });
    if (assignee) {
      await tracker.assign(key, assignee);
    }

    await moved(key);
    return key;
  };

  const sweeps = () => seen.filter((e) => e.type === "board.stale");
  const swept = () =>
    sweeps()
      .filter((e) => (e.data["tickets"] as unknown[]).length > 0)
      .map((e) => ({ subject: e.subject.ticket, tickets: e.data["tickets"] }));

  /** The first poll starts the clock; the sweep runs once `every` has passed. */
  const sweep = async () => {
    await ws.followMerges();
    clock.advance(HOUR);
    await ws.followMerges();
  };

  it("lists a review ticket whose pull requests all merged, and a blocked one whose blockers all closed", async () => {
    const review = await ticket("Done in fact", "review");
    const p = await vcs.seed.pullRequest(REPO, { title: "Work", body: `Closes ${review}` });
    await apply({ type: "pr.opened", subject: { pr: { repo: REPO, number: p.number } }, data: {} });
    await vcs.seed.merge(REPO, p.number, "dana");
    await apply({ type: "pr.closed", subject: { pr: { repo: REPO, number: p.number } }, data: {} });

    const blocker = await ticket("Blocker", "done");
    const blocked = await ticket("Waiting", "blocked");
    await tracker.link(blocker, blocked, "blocks");
    await moved(blocked);
    await ticket("Fine", "ready");

    await sweep();
    expect(swept()).toEqual([
      {
        subject: review,
        tickets: [
          {
            ticket: review,
            status: "review",
            reason: "prs_finished",
            facts: `its pull requests are all merged or closed: #${p.number} merged`,
          },
          {
            ticket: blocked,
            status: "blocked",
            reason: "blockers_closed",
            facts: `every ticket blocking it is closed: ${blocker} done`,
          },
        ],
      },
    ]);

    // Listed for the same reason again only after a day.
    clock.advance(HOUR);
    await ws.followMerges();
    expect(swept()).toHaveLength(1);
    clock.advance(23 * HOUR);
    await ws.followMerges();
    expect(swept()).toHaveLength(2);
  });

  it("lists a block that sat with a human, a stranded active ticket, a parent out of step, and a review with nobody", async () => {
    const dana = await tracker.seed.member({ name: "Dana", username: "dana" });
    const sam = await tracker.seed.member({ name: "Sam", username: "sam", kind: "agent" });
    const idle = await ticket("With dana", "blocked", dana.id);
    const stranded = await ticket("Nobody works on it", "active", sam.id);
    const parent = await ticket("Parent", "blocked");
    const sub = await ticket("Sub", "done");
    await tracker.setParent!(sub, parent);
    await moved(sub);
    const orphan = await ticket("Nobody to review", "review");

    await ws.followMerges();
    clock.advance(48 * HOUR);
    await ws.followMerges();
    const listed = swept()[0]!.tickets as { ticket: string; reason: string; facts: string }[];
    expect(Object.fromEntries(listed.map((t) => [t.ticket, t.reason]))).toEqual({
      [idle]: "idle_with_human",
      [stranded]: "stranded",
      [parent]: "subtickets_settled",
      [orphan]: "nothing_to_review",
    });

    expect(listed.find((t) => t.ticket === idle)?.facts).toContain("with no change for 48 hours");
  });

  it("lists nothing on a quiet board, sweeps nothing before the first interval, nor when off", async () => {
    await ticket("Fine", "active");
    await ws.followMerges();
    expect(sweeps()).toEqual([]);
    clock.advance(HOUR);
    await ws.followMerges();
    expect(sweeps().map((e) => [e.subject, e.data["tickets"]])).toEqual([[{}, []]]);

    await ws.stop();
    await build({ every: "off" });
    await ticket("Done in fact", "review");
    clock.advance(10 * HOUR);
    await ws.followMerges();
    expect(sweeps()).toHaveLength(1);
  });
});

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
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const DANA = { kind: "human" as const, id: "dana" };
const HOUR = 60 * 60 * 1000;

describe("work state: something a blocked ticket may wait on happened", () => {
  let clock: ManualClock;
  let store: Store;
  let tracker: FakeTracker;
  let vcs: FakeVcs;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  let n = 0;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    tracker = createFakeTracker({ now: clock.now });
    vcs = createFakeVcs({ now: clock.now });
    seen = [];
    ws = await createWorkState({
      store,
      ports: { vcs, tracker },
      team: teamConfig({
        policies: { merge_checks: { wait_for_start_minutes: 1, settle_minutes: 0 } },
      }),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const apply = (event: Omit<WorkflowEvent, "actor"> & { actor?: WorkflowEvent["actor"] }) =>
    ws.apply(
      { actor: DANA, ...event },
      { source: "tracker", externalId: `e${++n}`, trusted: true },
    );

  const moved = (key: string, data = {}) =>
    apply({ type: "ticket.moved", subject: { ticket: key }, data });

  const ticket = async (title: string, status: CanonicalStatus) => {
    const { key } = await tracker.createIssue({ title, body: "", status });
    await moved(key);
    return key;
  };

  const comment = (on: string, body: string, actor: WorkflowEvent["actor"] = DANA, data = {}) =>
    apply({ type: "ticket.commented", subject: { ticket: on }, actor, data: { body, ...data } });

  const nudges = () =>
    seen
      .filter((e) => e.type === "ticket.block_maybe_resolved")
      .map((e) => ({ ticket: e.subject.ticket, ...e.data, at: undefined }));

  /** A blocked ticket held by dana. */
  const blockedWithDana = async () => {
    const dana = await tracker.seed.member({ name: "Dana", username: "dana" });
    const key = await ticket("Ship", "blocked");
    await tracker.assign(key, dana.id);
    await moved(key);
    return key;
  };

  it("raises it when one of several blockers closes, and leaves the last one to ticket.unblocked", async () => {
    const [a, b] = [await ticket("One", "active"), await ticket("Two", "active")];
    const blocked = await ticket("Both", "blocked");
    await tracker.link(a, blocked, "blocks");
    await tracker.link(b, blocked, "blocks");
    await Promise.all([moved(a), moved(b), moved(blocked)]);

    await tracker.transition(a, "done");
    await moved(a, { to: "done" });
    expect(nudges()).toEqual([
      {
        ticket: blocked,
        cause: "blocker",
        ref: a,
        why: `its blocker ${a} closed; ${b} still block it`,
        at: undefined,
      },
    ]);

    await tracker.transition(b, "done");
    await moved(b, { to: "done" });
    expect(nudges()).toHaveLength(1);
    expect(seen.filter((e) => e.type === "ticket.unblocked")).toHaveLength(1);
  });

  it("raises it when the human holding it writes about it elsewhere, at most once a day", async () => {
    const key = await blockedWithDana();
    const other = await ticket("Elsewhere", "active");
    await comment(other, `The deploy is fixed, so ${key.toLowerCase()} can go on.`);
    await comment(other, `Again: ${key}.`);
    expect(nudges()).toEqual([
      {
        ticket: key,
        cause: "comment",
        ref: other,
        why: `dana, who holds it, wrote about it on ${other}`,
        at: undefined,
      },
    ]);

    clock.advance(23 * HOUR);
    await comment(other, `Still ${key}.`);
    expect(nudges()).toHaveLength(1);

    clock.advance(HOUR);
    await comment(other, `And ${key}.`);
    expect(nudges()).toHaveLength(2);
  });

  it("raises nothing for a comment on the ticket itself, by someone else, untrusted, or on a ticket not blocked", async () => {
    const key = await blockedWithDana();
    const other = await ticket("Elsewhere", "active");
    const open = await ticket("Open", "active");
    await comment(key, `About ${key}.`);
    await comment(other, `About ${key}.`, { kind: "human", id: "rae" });
    await comment(other, `About ${key}.`, DANA, { untrusted: true });
    await comment(other, `About ${key}.`, { kind: "agent", id: "sam" });
    await comment(other, `About ${open}.`);
    await apply({ type: "ticket.commented", subject: { ticket: other }, data: {} });
    expect(nudges()).toEqual([]);
  });

  it("raises it when a failed merge of a ticket whose work goes on passes later", async () => {
    const key = await ticket("Deploy", "blocked");
    const sub = await ticket("Follow-up", "active");
    await tracker.setParent!(sub, key);
    await moved(sub);
    const p = await vcs.seed.pullRequest(REPO, {
      author: { login: "acme-sam[bot]", kind: "agent" },
      title: "Deploy config",
      body: `Closes ${key}`,
    });

    await apply({ type: "pr.opened", subject: { pr: { repo: REPO, number: p.number } }, data: {} });
    const sha = (await vcs.seed.merge(REPO, p.number, "dana")).mergeCommitSha!;
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "failure" });
    await apply({ type: "pr.merged", subject: { pr: { repo: REPO, number: p.number } }, data: {} });
    const later = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, later, { name: "deploy", status: "success" });
    await ws.followMerges();
    expect(nudges()).toEqual([
      {
        ticket: key,
        cause: "check",
        ref: "deploy",
        why: `deploy passes on main at ${later.slice(0, 7)}, which includes #${p.number}'s merge`,
        at: undefined,
      },
    ]);
  });
});

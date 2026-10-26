import { describe, expect, it } from "vitest";
import { renderReplayReport } from "../report.js";
import { effectKey } from "../today.js";
import { runReplay } from "../replay.js";
import type { ReplayScenario, ReplayStep } from "../replay.types.js";
import { acmeSetup } from "./acme.js";
import { at, ev, pr, ticket } from "./fixture/build.js";

const setup = acmeSetup();
const one = (step: ReplayStep): ReplayScenario => ({ title: "One", steps: [step] });

const assigned: ReplayStep = {
  event: ev("assigned", "ticket.assigned", "ada.admin", { ticket: "ACME-1" }, at(0)),
  world: { tickets: { "ACME-1": ticket("ready", "sam") } },
};

const moved: ReplayStep = {
  event: ev("moved", "ticket.moved", "ada.admin", { ticket: "ACME-1" }, at(1), { to: "active" }),
  world: { tickets: { "ACME-1": ticket("active", "sam") } },
};

describe("effectKey", () => {
  it("keys every effect of today's engine", () => {
    expect(effectKey({ type: "assign", ticket: "ACME-1", to: null })).toBe("unassign ACME-1");
    expect(
      effectKey({
        type: "comment",
        on: {
          pr: { repo: { host: "github.com", owner: "acme-example", name: "shop" }, number: 4 },
        },
        template: "t",
        body: "b",
      }),
    ).toBe("comment on #4");
  });
});

describe("runReplay", () => {
  it("requires a note exactly where the two sides differ, starting with what kind of difference it is", () => {
    const unexplained = runReplay([one(moved)], setup);
    expect(unexplained.problems).toEqual([
      "replay:moved: the two sides decide differently and there is no note",
    ]);

    // A difference without a note gets an empty note cell, so the gap shows in the report too.
    expect(renderReplayReport(unexplained)).toContain("Pick the work up._ |  |\n");

    expect(runReplay([one({ ...assigned, note: "intended fix: x" })], setup).problems).toEqual([
      "replay:assigned: has a note, but both sides decide the same",
    ]);

    expect(runReplay([one({ ...moved, note: "fixed it" })], setup).problems).toEqual([
      'replay:moved: a note starts with "intended fix: " or "regression: "',
    ]);
  });

  it("skips, as the engine does, a schedule for someone who is not on the team", () => {
    const ghost: ReplayStep = {
      ...assigned,
      world: {
        tickets: { "ACME-1": { status: "ready", assignee: { id: "ghost", kind: "agent" } } },
      },
    };

    const row = runReplay([one(ghost)], setup).scenarios[0]!.rows[0]!;
    expect(row.today).toEqual(["(wake ghost (assigned): skipped, ghost is not on the team)"]);
    expect(row.same).toBe(true);
  });

  it("lists an event only today raises after a merge, and escapes table cells", () => {
    const base = pr(41, "Base", { by: "sam", head: "sam/a", state: "merged" });
    const top = pr(42, "Top | stacked", { by: "sam", head: "sam/b", base: "sam/a" });
    const merge: ReplayStep = {
      event: ev("merge", "pr.merged", "ada-admin", { pr: 41 }, at(2)),
      world: { prs: [base, { ...top, url: undefined } as never] },
      merge: {
        after: { 42: "conflicting" },
        notes: {
          "derived:pr.conflicted:acme-example/shop#42:after:acme-example/shop#41":
            "intended fix: the pipeline raises base_merged | instead",
          "derived:pr.base_merged:acme-example/shop#42:after:acme-example/shop#41":
            "intended fix: the pipeline raises base_merged instead",
        },
      },
    };

    const result = runReplay([one(merge)], setup);
    expect(result.problems).toEqual([]);
    const rows = result.scenarios[0]!.rows;
    expect(rows.map((r) => [r.event.type, r.today[0], r.pipeline[0]?.slice(0, 18)])).toEqual([
      ["pr.merged", undefined, "(drop: no policy m"],
      ["pr.base_merged", "(not raised today)", "wake sam (rebase):"],
      ["pr.conflicted", "wake sam (rebase)", "(not raised)"],
    ]);

    const report = renderReplayReport(result);
    expect(report).toContain("| 1 | `pr.merged` acme-example/shop#41 by ada-admin | - |");
    expect(report).toContain("raises base_merged \\| instead");
  });

  it("folds wakes in the report's coalescing section", () => {
    const report = renderReplayReport(
      runReplay(
        [
          {
            title: "Two",
            steps: [assigned, { ...assigned, event: { ...assigned.event, id: "replay:again" } }],
          },
        ],
        setup,
      ),
    );

    expect(report).toContain("The pipeline's 2 wakes become 1 runs");
    expect(report).toContain(
      "- sam, assigned on ticket ACME-1: 2 events (replay:assigned, replay:again)",
    );
  });
});

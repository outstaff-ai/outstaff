import { describe, expect, it } from "vitest";
import { renderReplayReport } from "#/pipeline/replay/report.js";
import { runReplay } from "#/pipeline/replay/replay.js";
import type { ReplayScenario, ReplayStep } from "#/pipeline/replay/replay.types.js";
import { acmeSetup } from "./acme.js";
import { at, ev, pr, ticket } from "./fixture/build.js";

const setup = acmeSetup();
const one = (step: ReplayStep): ReplayScenario => ({ title: "One", steps: [step] });

const assigned: ReplayStep = {
  event: ev("assigned", "ticket.assigned", "ada.admin", { ticket: "ACME-1" }, at(0)),
  world: { tickets: { "ACME-1": ticket("ready", "sam") } },
};

describe("runReplay", () => {
  it("lists what the pipeline decides for each event", () => {
    const row = runReplay([one(assigned)], setup).scenarios[0]!.rows[0]!;
    expect(row.derived).toBe(false);
    expect(row.decisions).toEqual([
      "wake sam (assigned): _ACME-1 is assigned to you. Work on it the way the repository asks._",
    ]);
  });

  it("runs the events a merge derives, shows a drop, and escapes table cells", () => {
    const base = pr(41, "Base", { by: "sam", head: "sam/a", state: "merged" });
    const top = pr(42, "Top | stacked", { by: "sam", head: "sam/b", base: "sam/a" });
    const merge: ReplayStep = {
      event: ev("merge", "pr.merged", "ada-admin", { pr: 41 }, at(2)),
      world: { prs: [base, { ...top, url: undefined } as never] },
      merge: { after: { 42: "conflicting" } },
    };

    const result = runReplay([one(merge)], setup);
    const rows = result.scenarios[0]!.rows;
    expect(rows.map((r) => [r.event.type, r.derived, r.decisions[0]?.slice(0, 18)])).toEqual([
      ["pr.merged", false, "(drop: no policy m"],
      ["pr.base_merged", true, "wake sam (rebase):"],
    ]);

    const report = renderReplayReport(result);
    expect(report).toContain("| 1 | `pr.merged` acme-example/shop#41 by ada-admin | (drop: ");
    expect(report).toContain("| 2 | derived `pr.base_merged`");
    expect(report).toContain("Top \\| stacked");
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

  it("shows a dash for an event with no decision line", () => {
    const report = renderReplayReport({
      scenarios: [
        { title: "Empty", rows: [{ event: assigned.event, derived: false, decisions: [] }] },
      ],
      coalesced: [],
    });

    expect(report).toContain("| 1 | `ticket.assigned` ACME-1 by ada.admin | - |");
  });
});

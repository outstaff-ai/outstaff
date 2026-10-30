import { describe, expect, it } from "vitest";
import {
  OFFICE,
  judge,
  onPr,
  prWorld,
  OPTS,
  prRef,
  stateOf,
  evaluatePipeline,
  BUILT_IN_POLICIES,
} from "./support.js";

describe("rebase_to_author", () => {
  it("conflicts, a base behind or merged, on an agent's open pull request, naming the cause", () => {
    for (const type of ["pr.conflicted", "pr.behind_base", "pr.base_merged"] as const) {
      const e = onPr(type, { cause: { pr: prRef(8), title: "Cart totals" } }, OFFICE);
      expect({ type, decided: judge("rebase_to_author", e, prWorld()) }).toEqual({
        type,
        decided: ["wake sam (rebase) on pr acme-example/shop#9"],
      });
    }

    const trace = evaluatePipeline(
      onPr("pr.behind_base", { cause: { pr: prRef(8), title: "Cart totals" } }, OFFICE),
      stateOf(prWorld()),
      BUILT_IN_POLICIES,
      OPTS,
    );

    expect(trace.decisions[0]).toMatchObject({
      instruction:
        "Your pull request #9 (Change 9) is behind its base branch, and the repository requires it to be up to date after #8 (Cart totals) merged. Bring it up to date with `main` the way the repository asks, and push. Then keep the pull request description current; if the approach changed, comment with what changed and why.",
    });

    expect(
      judge("rebase_to_author", onPr("pr.conflicted", {}, OFFICE), prWorld({}, "canceled")),
    ).toEqual({
      failed: { not: { ticket_status: ["canceled"] } },
    });
  });
});

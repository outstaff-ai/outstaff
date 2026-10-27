import { describe, expect, it } from "vitest";
import { compareOutcomes } from "#/pipeline/compare/compare.js";
import type { Outcome } from "#/pipeline/compare/compare.types.js";

const wake = (
  person: string,
  kind: string,
  ref = "acme-example/shop#9",
  policy = "review_to_author",
): Outcome => ({
  type: "wake",
  person,
  kind,
  subject: { type: "pr", ref },
  policy,
});

const move = (to: string, as = "office", policy?: string): Outcome => ({
  type: "move",
  ticket: "ACME-1",
  to,
  as,
  ...(policy ? { policy } : {}),
});

describe("compareOutcomes", () => {
  it("agrees on the same wakes and changes, noting who makes a change", () => {
    const engine: Outcome[] = [
      { ...wake("sam", "review_feedback"), policy: undefined },
      move("review"),
    ];

    const pipeline: Outcome[] = [
      wake("sam", "review_feedback"),
      move("review", "sam", "hand_back_done"),
    ];

    expect(compareOutcomes(engine, pipeline)).toEqual({
      agree: true,
      differences: [
        {
          kind: "actor_changed",
          engine: move("review"),
          pipeline: move("review", "sam", "hand_back_done"),
          policy: "hand_back_done",
          note: "attributed to sam, not the office",
        },
      ],
    });

    expect(compareOutcomes([], [])).toEqual({ agree: true, differences: [] });
  });

  it("finds what one side does and the other does not, and the same target done differently", () => {
    const engine: Outcome[] = [
      move("active"),
      { type: "comment", on: "ACME-1", as: "office" },
      { type: "assign", ticket: "ACME-1", to: { kind: "agent", id: "sam" }, as: "office" },
      wake("sam", "conflict_old"),
    ];

    const pipeline: Outcome[] = [
      wake("sam", "rebase", "acme-example/shop#9", "rebase_to_author"),
      { type: "assign", ticket: "ACME-1", to: null, as: "sam", policy: "p" },
      { type: "set_parent", ticket: "ACME-1", parent: "ACME-0", as: "sam", policy: "q" },
      wake("kofi", "rebase", "acme-example/shop#52", "rebase_to_author"),
    ];

    const r = compareOutcomes(engine, pipeline);
    expect(r.agree).toBe(false);
    expect(r.differences.map((d) => [d.kind, d.policy])).toEqual([
      ["missing_in_pipeline", undefined],
      ["missing_in_pipeline", undefined],
      ["different", "p"],
      ["different", "rebase_to_author"],
      ["extra_in_pipeline", "q"],
      ["extra_in_pipeline", "rebase_to_author"],
    ]);
  });

  it("compares comments and parents by their target", () => {
    const comment = (as: string): Outcome => ({ type: "comment", on: "ACME-1", as });
    const parent = (p: string): Outcome => ({
      type: "set_parent",
      ticket: "ACME-2",
      parent: p,
      as: "sam",
    });

    expect(
      compareOutcomes([comment("office")], [comment("sam")]).differences.map((d) => d.kind),
    ).toEqual(["actor_changed"]);

    expect(
      compareOutcomes([parent("ACME-1")], [parent("ACME-0")]).differences.map((d) => d.kind),
    ).toEqual(["different"]);
  });

  it("tells wakes apart by subject, and a wake without one", () => {
    const bare: Outcome = { type: "wake", person: "sam", kind: "chat" };
    expect(compareOutcomes([bare], [bare]).agree).toBe(true);
    expect(
      compareOutcomes([wake("sam", "k", "a")], [wake("sam", "k", "b")]).differences.map(
        (d) => d.kind,
      ),
    ).toEqual(["missing_in_pipeline", "extra_in_pipeline"]);
  });
});

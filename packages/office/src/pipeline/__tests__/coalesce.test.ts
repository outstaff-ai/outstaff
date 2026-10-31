import { describe, expect, it } from "vitest";
import { coalesceWakes } from "#/pipeline/coalesce.js";
import type { PendingWake } from "#/pipeline/coalesce.types.js";

const wake = (
  eventId: string,
  at: string,
  o: {
    person?: string;
    ref?: string;
    instruction?: string;
    policy?: string;
    kind?: string;
    coalesceMs?: number;
  } = {},
): PendingWake => ({
  eventId,
  at: `2026-10-05T09:${at}.000Z`,
  wake: {
    type: "wake",
    policy: o.policy ?? "review_to_author",
    person: o.person ?? "sam",
    kind: o.kind ?? "review_feedback",
    instruction: o.instruction ?? "Address the feedback.",
    feedback: [{ actor: "ada-admin", kind: "comment", body: eventId }],
    subject: { type: "pr", ref: o.ref ?? "acme-example/shop#60" },
    coalesceMs: o.coalesceMs ?? 60_000,
  },
});

describe("coalesceWakes", () => {
  it("folds wakes for one person and subject within the window into one run, oldest first", () => {
    const runs = coalesceWakes([
      wake("c", "00:45", { instruction: "Also this." }),
      wake("a", "00:00"),
      wake("b", "00:20", { policy: "other_policy", kind: "ci_failed" }),
    ]);

    expect(runs).toEqual([
      {
        person: "sam",
        subject: { type: "pr", ref: "acme-example/shop#60" },
        kind: "review_feedback",
        instructions: ["Address the feedback.", "Also this."],
        feedback: ["a", "b", "c"].map((body) => ({ actor: "ada-admin", kind: "comment", body })),
        policies: ["review_to_author", "other_policy"],
        events: ["a", "b", "c"],
        at: "2026-10-05T09:00:00.000Z",
      },
    ]);
  });

  it("keeps a merge in a run of its own, folding only merges into it", () => {
    const runs = coalesceWakes([
      wake("a", "00:00"),
      wake("b", "00:10", { kind: "merge", policy: "merge_ready" }),
      wake("c", "00:20", { kind: "merge", policy: "merge_ready" }),
      wake("d", "00:30"),
    ]);

    expect(runs.map((r) => [r.kind, r.events])).toEqual([
      ["review_feedback", ["a", "d"]],
      ["merge", ["b", "c"]],
    ]);
  });

  it("keeps other people, other subjects and wakes after the window apart", () => {
    const runs = coalesceWakes([
      wake("a", "00:00"),
      wake("b", "00:10", { person: "noor" }),
      wake("c", "00:20", { ref: "acme-example/shop#61" }),
      wake("d", "01:00"),
      wake("e", "01:30"),
    ]);

    expect(runs.map((r) => r.events)).toEqual([["a"], ["b"], ["c"], ["d", "e"]]);
  });

  it("folds nothing into or from a wake with no window, as a chat message's", () => {
    const now = (id: string) => wake(id, "00:00", { coalesceMs: 0 });
    expect(coalesceWakes([now("a"), now("b")]).map((r) => r.events)).toEqual([["a"], ["b"]]);
    expect(coalesceWakes([wake("a", "00:00"), now("b")]).map((r) => r.events)).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("closes the window the first wake opened, whatever the later ones' windows", () => {
    const runs = coalesceWakes([
      wake("a", "00:00", { coalesceMs: 10_000 }),
      wake("b", "00:05"),
      wake("c", "00:30"),
    ]);

    expect(runs.map((r) => r.events)).toEqual([["a", "b"], ["c"]]);
  });
});

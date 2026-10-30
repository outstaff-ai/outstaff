import { describe, expect, it } from "vitest";
import { runPolicy } from "#/run.js";
import type { ConfiguredPolicy } from "#/policy.types.js";
import { event, OPTS, stateOf } from "./support.js";

const input = { event: event("ticket.assigned"), state: stateOf(), options: OPTS };

const policy = (o: Partial<ConfiguredPolicy> = {}): ConfiguredPolicy => ({
  id: "p",
  summary: "test",
  on: ["ticket.assigned"],
  decide: () => [{ type: "drop", reason: "nothing to do" }],
  ...o,
});

describe("runPolicy", () => {
  it("says a policy is off, or listens to other events", () => {
    expect(runPolicy(policy({ enabled: false }), input)).toEqual({
      policy: "p",
      matched: false,
      reason: "turned off",
      proposals: [],
    });

    expect(runPolicy(policy({ on: ["pr.merged", "pr.opened"] }), input)).toMatchObject({
      matched: false,
      reason: "listens to pr.merged, pr.opened, not ticket.assigned",
    });
  });

  it("checks `when` first, then gives decide the context with why it matched", () => {
    expect(runPolicy(policy({ when: { actor_kind: "agent" } }), input)).toEqual({
      policy: "p",
      matched: false,
      reason: "actor is human, wanted agent",
      failed: { actor_kind: "agent" },
      proposals: [],
    });

    const seen: string[] = [];
    const run = runPolicy(
      policy({
        when: { actor_kind: "human" },
        settings: { until: "x" },
        decide: (e, ctx) => {
          seen.push(e.type, ctx.matched, String(ctx.settings["until"]));
          return [];
        },
      }),
      input,
    );

    expect(run).toEqual({
      policy: "p",
      matched: true,
      reason: "actor is human, wanted human",
      proposals: [],
    });

    expect(seen).toEqual(["ticket.assigned", "actor is human, wanted human", "x"]);
    expect(runPolicy(policy(), input)).toMatchObject({
      matched: true,
      reason: "no condition",
      proposals: [{ type: "drop", reason: "nothing to do" }],
    });
  });

  it("contains a policy that throws, or returns something that is not proposals", () => {
    const throws = policy({
      decide: () => {
        throw new Error("boom");
      },
    });

    expect(runPolicy(throws, input)).toEqual({
      policy: "p",
      matched: true,
      reason: "no condition",
      proposals: [{ type: "error", reason: "threw: boom" }],
    });

    const throwsText = policy({
      decide: () => {
        throw "plain";
      },
    });

    expect(runPolicy(throwsText, input).proposals).toEqual([
      { type: "error", reason: "threw: plain" },
    ]);

    const odd = policy({ decide: () => "nope" as never });
    expect(runPolicy(odd, input).proposals).toEqual([
      { type: "error", reason: "returned something other than a list of proposals" },
    ]);

    const badWhen = policy({ when: { no_such_condition: true } as never });
    expect(runPolicy(badWhen, input)).toMatchObject({
      proposals: [{ type: "error", reason: expect.stringMatching(/^threw: /) }],
    });
  });
});

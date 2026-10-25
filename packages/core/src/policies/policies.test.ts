import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../config/parse.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import { describePolicies } from "./describe.js";
import { POLICY_SWITCHES, policyOn, policyValue } from "./switches.js";

const config = (extra: Record<string, unknown> = {}) => {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Dana", identities: { tracker: "dana" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "r" }],
    integrations: { chat: { adapter: "a" }, vcs: { adapter: "b" }, runtime: { adapter: "c" } },
    ...extra,
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
};

const report = (extra: Record<string, unknown> = {}) => {
  const c = config(extra);
  const w = resolveWorkflow(c.workflow, c.humans, c.policies);
  return Object.fromEntries(
    describePolicies(c, w, extra["policies"]).map((r) => [r.switch.path, [r.value, r.source]]),
  );
};

describe("policy switches", () => {
  it("the registry defaults are the schema defaults", () => {
    const parsed = config({ policies: {} }).policies;
    for (const sw of POLICY_SWITCHES) {
      expect(policyValue(parsed, sw.path)).toBe(sw.default);
      expect(policyValue(undefined, sw.path)).toBe(sw.default);
      expect(policyOn(undefined, sw.path)).toBe(true);
    }
  });

  it("lists every switch with its source", () => {
    expect(report({ policies: { acknowledge: { vcs: false } } })).toMatchObject({
      "acknowledge.chat": [true, "default"],
      "acknowledge.vcs": [false, "team.yaml"],
      "chat.profile": [true, "default"],
      "hand_back.reassign": ["requester", "default"],
      "conflicts.follow_up": [true, "default"],
    });
  });

  it("names the preset when it has no rule for a switch", () => {
    expect(report({ workflow: { preset: "minimal" } })).toMatchObject({
      "conflicts.follow_up": [false, "preset"],
      "hand_back.reassign": ["none", "preset"],
    });
  });

  it("names workflow.rules when an explicit rule wins over the switch", () => {
    const r = report({
      policies: { conflicts: { follow_up: false } },
      workflow: {
        rules: [{ id: "conflict-back-to-author", on: "pr.conflicted", do: [{ move: "active" }] }],
      },
    });

    expect(r["conflicts.follow_up"]).toEqual([true, "workflow.rules"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../config/parse.js";
import { resolveWorkflow } from "../workflow/resolve.js";
import { describePolicies } from "./describe.js";
import { POLICY_SWITCHES, blockedNotify, policyOn, policyValue } from "./switches.js";

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
      expect(policyOn(undefined, sw.path)).toBe(sw.default !== sw.off);
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

describe("blockedNotify", () => {
  const withPm = config({
    people: [
      { handle: "sam", name: "Sam", role: "r" },
      { handle: "pia", name: "Pia", role: "pm" },
    ],
  });

  it("is pm when the team has a PM role, else agent", () => {
    expect(blockedNotify(withPm)).toBe("pm");
    expect(blockedNotify(config())).toBe("agent");
  });

  it("is agent when the switch says so, even with a PM", () => {
    const c = config({
      people: [{ handle: "pia", name: "Pia", role: "pm" }],
      policies: { hand_back: { blocked_notify: "agent" } },
    });

    expect(blockedNotify(c)).toBe("agent");
  });
});

describe("describePolicies for the blocked_notify switch", () => {
  const value = (c: ReturnType<typeof config>) => {
    const w = resolveWorkflow(c.workflow, c.humans, c.policies);
    return describePolicies(c, w, undefined).find(
      (r) => r.switch.path === "hand_back.blocked_notify",
    )!;
  };

  it("shows agent with a note when the team has no PM", () => {
    expect(value(config())).toMatchObject({ value: "agent", note: "no pm role on the team" });
  });

  it("shows pm when the team has a PM", () => {
    const r = value(config({ people: [{ handle: "pia", name: "Pia", role: "pm" }] }));
    expect(r.value).toBe("pm");
    expect(r.note).toBeUndefined();
  });
});

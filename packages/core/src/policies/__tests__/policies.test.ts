import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "#/config/parse.js";
import { describePolicies } from "#/policies/describe.js";
import { POLICY_SWITCHES, blockedNotify, policyOn, policyValue } from "#/policies/switches.js";

const config = (extra: Record<string, unknown> = {}) => {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    humans: [{ name: "Dana", identities: { tracker: "dana" } }],
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "github.com/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "r", model: "sonnet" }],
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
  return Object.fromEntries(
    describePolicies(c, extra["policies"]).map((r) => [r.switch.path, [r.value, r.source]]),
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
      "feedback.follow_up_round": [true, "default"],
      "tickets.prs_per_ticket": ["one", "default"],
    });
  });

  it("has no switch for what the pipeline's policies decide", () => {
    const paths = POLICY_SWITCHES.map((s) => s.path);
    for (const gone of [
      "feedback.merged_prs",
      "hand_back.reassign",
      "conflicts.follow_up",
      "retry.on_signal",
      "tickets.start_moves_active",
    ]) {
      expect(paths).not.toContain(gone);
    }
  });
});

describe("blockedNotify", () => {
  const withPm = config({
    people: [
      { handle: "sam", name: "Sam", role: "r", model: "sonnet" },
      { handle: "pia", name: "Pia", role: "pm", model: "sonnet" },
    ],
  });

  it("is pm when the team has a PM role, else agent", () => {
    expect(blockedNotify(withPm)).toBe("pm");
    expect(blockedNotify(config())).toBe("agent");
  });

  it("is agent when the switch says so, even with a PM", () => {
    const c = config({
      people: [{ handle: "pia", name: "Pia", role: "pm", model: "sonnet" }],
      policies: { hand_back: { blocked_notify: "agent" } },
    });

    expect(blockedNotify(c)).toBe("agent");
  });
});

describe("describePolicies for the blocked_notify switch", () => {
  const value = (c: ReturnType<typeof config>) =>
    describePolicies(c, undefined).find((r) => r.switch.path === "hand_back.blocked_notify")!;

  it("shows agent with a note when the team has no PM", () => {
    expect(value(config())).toMatchObject({ value: "agent", note: "no pm role on the team" });
  });

  it("shows pm when the team has a PM", () => {
    const r = value(
      config({ people: [{ handle: "pia", name: "Pia", role: "pm", model: "sonnet" }] }),
    );

    expect(r.value).toBe("pm");
    expect(r.note).toBeUndefined();
  });
});

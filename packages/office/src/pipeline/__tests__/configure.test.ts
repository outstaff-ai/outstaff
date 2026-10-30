import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import type { ConfiguredPolicy } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { configurePipeline } from "#/pipeline/configure.js";
import { BUILT_IN_POLICIES } from "#/pipeline/policies/index.js";

function team(extra: Record<string, unknown> = {}): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "ada.admin" } }],
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
    ...extra,
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

const byId = <T extends { id: string }>(policies: T[], id: string): T =>
  policies.find((p) => p.id === id)!;

describe("configurePipeline", () => {
  it("keeps the defaults in order, all on", () => {
    const { policies, options, issues } = configurePipeline(team());
    expect(policies.map((p) => p.id)).toEqual(BUILT_IN_POLICIES.map((p) => p.id));
    expect(policies.every((p) => p.enabled)).toBe(true);
    expect(options).toMatchObject({
      people: ["sam"],
      fallbackRequester: "ada.admin",
      approvers: ["humans"],
    });

    expect(issues).toEqual([]);
  });

  it("follows policies.pull_ready for the idle pull", () => {
    expect(byId(configurePipeline(team()).policies, "idle_pulls_next").enabled).toBe(true);
    const off = configurePipeline(team({ policies: { pull_ready: false } }));
    expect(byId(off.policies, "idle_pulls_next").enabled).toBe(false);
  });

  it("turns policies on and off, narrows them and replaces wake instructions", () => {
    const { policies, issues } = configurePipeline(
      team({
        pipeline: {
          policies: {
            chat_to_addressed: { enabled: false },
            review_to_author: {
              instruction: "Answer {{actor.id}} on #{{pr.number}}.",
              when: { not: { has_label: "$needs_human" } },
            },
            idle_pulls_next: { when: { actor_kind: "agent" } },
          },
        },
      }),
    );

    expect(issues).toEqual([]);
    expect(byId(policies, "chat_to_addressed")).toMatchObject({ enabled: false });
    const review = byId(policies, "review_to_author");
    expect(review).toMatchObject({
      instruction: "Answer {{actor.id}} on #{{pr.number}}.",
      when: {
        all: [
          BUILT_IN_POLICIES.find((p) => p.id === "review_to_author")!.when,
          { not: { has_label: "$needs_human" } },
        ],
      },
    });

    expect(byId(policies, "idle_pulls_next")).toMatchObject({ when: { actor_kind: "agent" } });
  });

  it("reports unknown policies and unusable instructions, and keeps the defaults", () => {
    const { policies, issues } = configurePipeline(
      team({
        pipeline: {
          policies: {
            no_such_policy: { enabled: false },
            review_to_author: { instruction: "Hi {{nobody}}" },
            merged_closes_ticket: { instruction: "Closed for {{person}}." },
          },
        },
      }),
    );

    expect(issues).toEqual([
      "pipeline.policies.no_such_policy: no policy has this id",
      "pipeline.policies.review_to_author.instruction: unknown variable nobody; the default is kept",
    ]);

    expect(byId(policies, "review_to_author").instruction).toBe(
      BUILT_IN_POLICIES.find((p) => p.id === "review_to_author")!.instruction,
    );

    // An act's instruction is the note the office posts with its changes.
    expect(byId(policies, "merged_closes_ticket").instruction).toBe("Closed for {{person}}.");
  });

  it("runs the custom policies after the built-in ones, with the team's changes, and skips one whose id is taken", () => {
    const custom = (id: string): ConfiguredPolicy => ({
      id,
      summary: "custom",
      on: ["ticket.assigned"],
      decide: () => [],
      settings: { until: "2026-12-01" },
    });

    const { policies, issues } = configurePipeline(
      team({ pipeline: { policies: { release_freeze: { enabled: false } } } }),
      [custom("release_freeze"), custom("chat_to_addressed"), custom("release_freeze")],
    );

    expect(policies.map((p) => p.id)).toEqual([
      ...BUILT_IN_POLICIES.map((p) => p.id),
      "release_freeze",
    ]);

    expect(policies.at(-1)).toMatchObject({ enabled: false, settings: { until: "2026-12-01" } });
    expect(issues).toEqual([
      "policies.custom: the id chat_to_addressed is taken by another policy; this one is not loaded",
      "policies.custom: the id release_freeze is taken by another policy; this one is not loaded",
    ]);
  });

  it("takes the wake window from pipeline.wake.coalesce_seconds", () => {
    expect(configurePipeline(team()).options.coalesceMs).toBeUndefined();
    const set = configurePipeline(team({ pipeline: { wake: { coalesce_seconds: 5 } } }));
    expect(set.options.coalesceMs).toBe(5000);
  });
});

import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { configurePipeline } from "../configure.js";
import { DEFAULT_POLICIES } from "../defaults.js";

function team(extra: Record<string, unknown> = {}): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "ada.admin" } }],
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer" }],
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
  it("keeps the defaults in order, with merging on approval off unless the team turns it on", () => {
    const { policies, options, issues } = configurePipeline(team());
    expect(policies.map((p) => p.id)).toEqual(DEFAULT_POLICIES.map((p) => p.id));
    expect(byId(policies, "approval_to_merge")).toMatchObject({ enabled: false });
    expect(byId(policies, "review_to_author")).toMatchObject({ enabled: true });
    expect(options).toMatchObject({
      people: ["sam"],
      fallbackRequester: "ada.admin",
      approvers: ["humans"],
    });

    expect(issues).toEqual([]);

    const on = configurePipeline(team({ policies: { merge: { on_approval: true } } }));
    expect(byId(on.policies, "approval_to_merge_after_feedback")).toMatchObject({ enabled: true });
  });

  it("turns policies on and off, narrows them and replaces wake instructions", () => {
    const { policies, issues } = configurePipeline(
      team({
        pipeline: {
          policies: {
            chat_to_addressed: { enabled: false },
            approval_to_merge: { enabled: true },
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
    expect(byId(policies, "approval_to_merge")).toMatchObject({ enabled: true });
    const review = byId(policies, "review_to_author");
    expect(review).toMatchObject({
      instruction: "Answer {{actor.id}} on #{{pr.number}}.",
      when: {
        all: [
          DEFAULT_POLICIES.find((p) => p.id === "review_to_author")!.when,
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
      DEFAULT_POLICIES.find((p) => p.id === "review_to_author")!.instruction,
    );

    // An act's instruction is the note the office posts with its changes.
    expect(byId(policies, "merged_closes_ticket").instruction).toBe("Closed for {{person}}.");
  });
});

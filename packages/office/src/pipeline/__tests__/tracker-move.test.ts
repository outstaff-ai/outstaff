import { parseTeamConfig, silentLogger, type TeamConfig, type WorkflowEvent } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import { createItsaplanTracker, trackerOptions } from "@outstaff/integration.tracker.itsaplan";
import { API_ORIGIN, createStubFetch, secretMap } from "@outstaff/testing.itsaplan";
import { createItsaplanStandIn } from "@outstaff/testing.itsaplan/stand-in";
import { describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createIntake } from "#/intake/intake.js";
import type { IntakeMeta } from "#/intake/types.js";
import { openStore } from "#/store/index.js";
import { configurePipeline } from "#/pipeline/configure.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { toPipelineEvent } from "#/pipeline/from-workflow.js";
import { stateOf } from "./support.js";

function team(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Rio Park", identities: { tracker: "rio" } }],
    repos: [{ name: "shop", url: "git.acme.example/acme-example/shop", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        model: "sonnet",
        identities: { tracker: "u-sam" },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "itsaplan", url: "https://tracker.acme.example", project: "SHOP" },
    },
    // The Its a Plan stand-in's columns: active is "In Progress".
    workflow: { statuses: { active: "In Progress" } },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

describe("a human moving a ticket in the tracker", () => {
  it("reaches the pipeline as a move to active and wakes the agent the ticket is assigned to", async () => {
    const config = team();
    // One Its a Plan project that the office and Rio, a human on the team, each reach with their own key.
    const { routes } = createItsaplanStandIn({
      keys: { "key-office": "u-office", "key-rio": "u-rio" },
      members: [
        { userId: "u-office", name: "Office", username: "office", kind: "member" },
        { userId: "u-sam", name: "Sam Duarte", username: "sam", kind: "member" },
        { userId: "u-rio", name: "Rio Park", username: "rio", kind: "member" },
      ],
    });

    const tracker = (key: string) =>
      createItsaplanTracker({
        options: trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
        secrets: secretMap({ ITSAPLAN_API_KEY: key }),
        team: config,
        log: silentLogger,
        fetch: createStubFetch(routes, API_ORIGIN, key).fetch,
        now: () => new Date("2026-01-01T00:00:00Z"),
      });

    const clock = manualClock();
    const intake = createIntake({
      store: await openStore("sqlite::memory:"),
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker: await tracker("key-office") },
      team: config,
      clock,
      logger: silentLogger,
    });

    // Sam's ticket is there before the office starts; the first poll only sets the baseline.
    const rio = await tracker("key-rio");
    const issue = await rio.createIssue({ title: "Search", body: "", assignee: "u-sam" });
    await intake.pollOnce();
    const events: { event: WorkflowEvent; meta: IntakeMeta }[] = [];
    intake.onEvent((event, meta) => void events.push({ event, meta }));

    // Rio, a trusted human, moves it to In Progress in the tracker.
    await rio.transition(issue.key, "active");
    await intake.pollOnce();

    const moved = events.find((e) => e.event.type === "ticket.moved")!;
    expect(moved.event).toMatchObject({
      actor: { kind: "human", id: "rio" },
      data: { from: "backlog", fromName: "Backlog", to: "active", toName: "In Progress" },
    });

    const event = toPipelineEvent(moved.event, moved.meta, clock.now().toISOString())!;
    const world = {
      tickets: {
        [issue.key]: { status: "active" as const, assignee: { kind: "agent" as const, id: "sam" } },
      },
    };

    const { policies, options } = configurePipeline(config);
    const trace = evaluatePipeline(event, stateOf(world), policies, options);
    expect(trace.policies.find((p) => p.policy === "moved_active_to_assignee")).toMatchObject({
      matched: true,
    });

    expect(trace.decisions).toMatchObject([
      { type: "wake", policy: "moved_active_to_assignee", person: "sam" },
    ]);
  });
});

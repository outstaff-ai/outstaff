import { parseTeamConfig } from "@outstaff/core";
import type { Member, RepoRef, StatusMap, TeamConfig, WorkflowEvent } from "@outstaff/core";
import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { manualClock } from "#/clock.js";
import { openStore } from "#/store/index.js";
import { createIntake } from "#/intake/intake.js";
import type { IntakeMeta, IntakeOptions } from "#/intake/types.js";

export const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };

export function teamConfig(extra: Record<string, unknown> = {}): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        identities: { vcs: "acme-sam[bot]", tracker: "u-sam" },
      },
      { handle: "noor", name: "Noor", role: "reviewer", identities: { vcs: "Acme-Noor[bot]" } },
    ],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "agent-sdk" },
      tracker: { adapter: "itsaplan" },
    },
    ...extra,
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

export const human = (id: string, username = id): Member => ({
  id,
  name: username,
  username,
  kind: "human",
});

export async function setup(
  over: Partial<IntakeOptions> & {
    teamExtra?: Record<string, unknown>;
    trackerActor?: Member;

    /** The status names the fake tracker uses; the team's map is `teamExtra.workflow.statuses`. */
    trackerStatuses?: StatusMap;
    noHandler?: boolean;

    /** Skip the baseline poll, to exercise the first poll itself. */
    noBaseline?: boolean;
  } = {},
) {
  const clock = manualClock();
  const store = over.store ?? (await openStore("sqlite::memory:"));
  const vcs = createFakeVcs({ now: clock.now });
  const tracker = createFakeTracker({
    now: clock.now,
    ...(over.trackerActor ? { actor: over.trackerActor } : {}),
    ...(over.trackerStatuses ? { statusMap: over.trackerStatuses } : {}),
  });

  const events: { event: WorkflowEvent; meta: IntakeMeta }[] = [];
  const intake = createIntake({
    store,
    ports: { vcs, tracker },
    team: teamConfig(over.teamExtra),
    clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  });

  // The first poll only sets the baseline; seeding after it makes events count as new.
  if (!over.noBaseline && (await store.getCursor("vcs", "events")) === undefined) {
    await intake.pollOnce();
  }

  if (!over.noHandler) {
    intake.onEvent((event, meta) => void events.push({ event, meta }));
  }

  return { clock, store, vcs, tracker, events, intake };
}

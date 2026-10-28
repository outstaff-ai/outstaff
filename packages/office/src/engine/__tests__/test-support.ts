import type { Logger, Member, TeamConfig, WorkflowEvent } from "@outstaff/core";
import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { manualClock } from "#/clock.js";
import { createIntake } from "#/intake/index.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/index.js";
import { createWorkState } from "#/workstate/index.js";
import { createEngine } from "#/engine/engine.js";

export const SAM = "acme-sam[bot]";
export const silent = { debug() {}, info() {}, warn() {}, error() {} };

export interface HarnessOptions {
  noTracker?: boolean;
  team?: TeamConfig;
  workflow?: Record<string, unknown>;
  logger?: Logger;
}

/** Fakes -> intake -> work state -> engine -> fakes, all on an in-memory store and a manual clock. */
export async function harness(o: HarnessOptions = {}) {
  const clock = manualClock();
  const store = await openStore("sqlite::memory:", { now: () => clock.now() });
  const vcs = createFakeVcs({ now: clock.now });
  const tracker = createFakeTracker({
    now: clock.now,
    actor: { id: "u-sam", name: "Sam", kind: "agent" },
  });

  const team =
    o.team ??
    teamConfig({
      humans: [
        { name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } },
        { name: "Grace", identities: { vcs: "grace", tracker: "grace" } },
      ],
      ...(o.workflow ? { workflow: o.workflow } : {}),
    });

  const tracked = o.noTracker ? undefined : tracker;
  const ws = await createWorkState({
    store,
    ports: { vcs, tracker },
    team,
    clock,
    logger: o.logger ?? silent,
  });

  // Intake sees only the VCS: tracker events are delivered by hand so a test controls who caused them.
  const intake = createIntake({ store, ports: { vcs }, team, clock, logger: o.logger ?? silent });
  const scheduler = createScheduler({ store, team, clock, logger: silent });
  const engine = createEngine({
    store,
    workState: ws,
    scheduler,
    team,
    clock,
    logger: o.logger ?? silent,
    ports: tracked ? { tracker: tracked } : {},
  });

  intake.onEvent((event, meta) => ws.apply(event, meta));
  intake.onEvent((event, meta) => engine.handle(event, meta).then(() => undefined));
  ws.onEvent((event, meta) => engine.handle(event, meta).then(() => undefined));

  let n = 0;
  const h = {
    clock,
    store,
    vcs,
    tracker,
    team,
    ws,
    intake,
    scheduler,
    engine,
    poll: () => intake.pollOnce(),

    /** A tracker event, as intake would deliver it once the work state has applied it. */
    async deliver(event: WorkflowEvent, trusted = true) {
      const meta = { source: "tracker", externalId: `t${++n}`, trusted } as const;
      await ws.apply(event, meta);
      return engine.handle(event, meta);
    },
    async human(name: string): Promise<Member> {
      return tracker.seed.member({ name, kind: "human" });
    },
    async items(person?: string) {
      return store.listItems(person ? { person } : {});
    },
    async close() {
      await ws.stop();
      await store.close();
    },
  };

  // The first poll only sets the baseline; whatever a test seeds afterwards is new.
  await intake.pollOnce();
  await vcs.seed.permission(REPO, "dana", "write");
  await vcs.seed.permission(REPO, "grace", "write");
  return h;
}

export type Harness = Awaited<ReturnType<typeof harness>>;

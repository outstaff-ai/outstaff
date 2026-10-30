import {
  createStaticWorkflowState,
  parseTeamConfig,
  silentLogger,
  type Logger,
  type TeamConfig,
} from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { readFeedback } from "#/work-feedback.js";
import { createScheduler, type EnqueueInput } from "#/scheduler/index.js";
import { openStore, type Store } from "#/store/index.js";
import type { Act } from "#/pipeline/decisions.types.js";
import { createMemoryTraceStore } from "#/pipeline/memory-traces.js";
import { createLivePipeline } from "#/pipeline/live/live.js";
import type { LiveOptions } from "#/pipeline/live/live.types.js";
import { enqueueWake, ITEM_EVENTS_SUBJECT, WAKE_SUBJECT } from "#/pipeline/live/wake.js";

const REPO = { host: "github.com", owner: "acme-example", name: "shop" };

function team(pipeline?: unknown): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
    ...(pipeline ? { pipeline } : {}),
  });

  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
}

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

async function setup(extra: { pipeline?: unknown; logger?: Logger } = {}) {
  store = await openStore("sqlite::memory:");
  const s = store;
  const acts: Act[] = [];
  const workState = {
    ...createStaticWorkflowState({
      tickets: { "ACME-1": { status: "ready", assignee: { id: "sam", kind: "agent" } } },
      prs: [
        {
          ref: { repo: REPO, number: 9 },
          title: "Wishlist",
          headRef: "sam/acme-1",
          baseRef: "main",
          draft: false,
          state: "open",
          author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
        },
      ],
      links: { 9: "ACME-1" },
    }),
    prSubject: (pr: { number: number }) => `github.com/acme-example/shop#${pr.number}`,
    ticket: (key: string) => (key === "ACME-1" ? { title: "Search page" } : undefined),
    readyTickets: (person: string) =>
      person === "sam" ? [{ key: "ACME-1", readyAt: "2026-10-05T07:00:00.000Z" }] : [],
  };

  const opts: LiveOptions = {
    team: team(extra.pipeline),
    store: s,
    workState: workState as never,
    scheduler: {
      async enqueue(input: EnqueueInput) {
        const item = await s.enqueue(input);
        await input.init?.(item);
        return item;
      },
    },
    executor: { execute: async (a) => void acts.push(a) },
    traces: createMemoryTraceStore(),
    clock: manualClock(),
    logger: extra.logger ?? silentLogger,
  };

  return { opts, acts, store: s };
}

const assigned = {
  type: "ticket.assigned" as const,
  subject: { ticket: "ACME-1" },
  actor: { kind: "human" as const, id: "ada.admin" },
  data: {},
};

describe("createLivePipeline", () => {
  it("queues the wake with its instruction and reason, and passes acts to the executor", async () => {
    const { opts, acts, store: s } = await setup();
    const live = createLivePipeline(opts);
    await live.handle(assigned, { source: "tracker", externalId: "e-1" });
    const [item] = await s.listItems({ person: "sam" });
    expect(item).toMatchObject({
      kind: "assigned",
      title: "assigned: ACME-1 Search page",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect((await s.readJournal(item!.id)).map((j) => j.text)).toEqual([
      "ACME-1 is assigned to you. Work on it the way the repository asks.",
    ]);

    const traced = await opts.traces.get("tracker:e-1");
    expect(traced?.decisions).toMatchObject([{ type: "wake", itemId: item!.id }]);
    expect(traced?.policies.find((p) => p.matched)?.decisions).toMatchObject([
      { itemId: item!.id },
    ]);

    expect((await s.getSubject(WAKE_SUBJECT, item!.id))?.data).toEqual({
      event: "tracker:e-1",
      policy: "assigned_to_assignee",
    });

    await live.handle(
      {
        type: "agent.handed_back",
        subject: { ticket: "ACME-1" },
        actor: { kind: "agent", id: "sam" },
        data: { status: "done", kind: "assigned" },
      },
      { source: "workstate", externalId: "hb-1" },
    );

    expect(acts).toMatchObject([{ type: "act", as: "sam", policy: "hand_back_done" }]);

    // A second assignment of the same ticket joins the queued item, and its trace says so.
    const again = await live.handle(assigned, { source: "tracker", externalId: "e-2" });
    expect(again?.decisions).toMatchObject([{ type: "wake", itemId: item!.id }]);
    expect(await s.listItems({ person: "sam" })).toHaveLength(1);
    expect(
      await live.handle({ ...assigned, type: "schedule.cron" }, { source: "o", externalId: "c" }),
    ).toBeUndefined();
  });

  it("wakes an idle agent with its next ready ticket, as automatic work, or drops", async () => {
    const { opts } = await setup();
    const live = createLivePipeline(opts);
    const idle = (person: string) => ({
      id: `office:idle:${person}:2026-10-05T09:00:00.000Z`,
      type: "agent.idle" as const,
      at: "2026-10-05T09:00:00.000Z",
      subject: {},
      actor: { kind: "agent" as const, id: person },
      data: {},
    });

    const trace = await live.judge(idle("sam"));
    expect(trace?.decisions).toMatchObject([
      { type: "wake", policy: "idle_pulls_next", subject: { type: "ticket", ref: "ACME-1" } },
    ]);

    const [item] = await store!.listItems({ person: "sam" });
    expect(item).toMatchObject({
      kind: "assigned",
      trigger: "automation",
      title: "assigned: ACME-1 Search page",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect((await live.judge(idle("mira")))?.decisions).toEqual([
      {
        type: "drop",
        policy: "idle_pulls_next",
        reason: "no one to wake: mira (actor) is not an agent on the team",
      },
    ]);
  });

  it("logs configuration issues", async () => {
    const warned: string[] = [];
    const { opts } = await setup({
      pipeline: { policies: { nope: { enabled: false } } },
      logger: { ...silentLogger, warn: (m) => void warned.push(m) },
    });

    createLivePipeline(opts);
    expect(warned).toEqual(["pipeline: pipeline.policies.nope: no policy has this id"]);
  });
});

describe("enqueueWake", () => {
  const feedback = [{ actor: "ada-admin", kind: "comment" as const, body: "Rename it." }];
  const prWake = {
    type: "wake" as const,
    policy: "review_to_author",
    person: "sam",
    kind: "review_feedback",
    instruction: "Address it.",
    feedback,
    subject: { type: "pr" as const, ref: "acme-example/shop#9" },
  };

  const onPr = (n: number) => ({
    id: `vcs:c-${n}`,
    type: "pr.comment" as const,
    at: "2026-10-05T09:00:00.000Z",
    subject: { pr: { repo: REPO, number: n } },
    actor: { kind: "human" as const, id: "ada-admin" },
    data: {},
  });

  it("keys a pull request by the work state's subject and joins a live item of the same kind", async () => {
    const { opts, store: s } = await setup();
    const queued = await enqueueWake(prWake, onPr(9), opts);
    expect(queued.folded).toBeUndefined();
    const [item] = await s.listItems({ person: "sam" });
    expect(item).toMatchObject({
      title: "review feedback: PR #9 Wishlist",
      subject: { type: "pr", ref: "github.com/acme-example/shop#9" },
    });

    expect(queued.itemId).toBe(item!.id);
    expect(await enqueueWake(prWake, onPr(9), opts)).toEqual({
      itemId: item!.id,
      folded: ["vcs:c-9"],
    });

    expect(await enqueueWake(prWake, onPr(11), opts)).toEqual({ itemId: expect.any(String) });
    expect(await enqueueWake(prWake, { ...onPr(9), id: "vcs:c-other" }, opts)).toEqual({
      itemId: item!.id,
      folded: ["vcs:c-9", "vcs:c-other"],
    });

    expect((await s.getSubject(ITEM_EVENTS_SUBJECT, item!.id))?.data).toEqual([
      "vcs:c-9",
      "vcs:c-other",
    ]);

    expect(await readFeedback(s, item!.id)).toEqual([...feedback, ...feedback, ...feedback]);
  });

  it("titles a pull request the work state does not know, a ticket it does not know, and a document", async () => {
    const { opts, store: s } = await setup();
    await enqueueWake(prWake, onPr(10), opts);
    await enqueueWake(
      { ...prWake, kind: "assigned", subject: { type: "ticket", ref: "ACME-9" } },
      onPr(10),
      opts,
    );

    await enqueueWake(
      { ...prWake, kind: "doc_feedback", subject: { type: "doc", ref: "doc-7" } },
      { ...onPr(10), subject: {} },
      opts,
    );

    expect((await s.listItems({ person: "sam" })).map((i) => i.title).toSorted()).toEqual([
      "assigned: ACME-9",
      "doc feedback: doc-7",
      "review feedback: PR #10",
    ]);
  });

  it("folds a wake of another kind for the same subject into the held item, with its instruction", async () => {
    const { opts, store: s } = await setup();
    const clock = manualClock("2026-10-05T09:00:00.000Z");
    const scheduler = createScheduler({ store: s, team: opts.team, clock });
    const withScheduler = { ...opts, scheduler, clock };
    const first = await enqueueWake(prWake, onPr(9), withScheduler);
    const ci = {
      ...prWake,
      policy: "ci_failed_to_author",
      kind: "ci_failed",
      instruction: "Fix the checks.",
    };

    const second = await enqueueWake(
      ci,
      { ...onPr(9), id: "vcs:ci-9", type: "pr.ci_failed", at: "2026-10-05T09:00:30.000Z" },
      withScheduler,
    );

    expect(second).toEqual({ itemId: first.itemId, folded: ["vcs:c-9", "vcs:ci-9"] });
    expect(await s.listItems({ person: "sam" })).toMatchObject([
      { kind: "review_feedback", notBefore: "2026-10-05T09:01:00.000Z" },
    ]);

    expect((await s.readJournal(first.itemId)).map((j) => j.text)).toEqual([
      "Address it.",
      "Fix the checks.",
    ]);
  });
});

import {
  createStaticWorkflowState,
  parseTeamConfig,
  type CanonicalStatus,
  type Logger,
  type TeamConfig,
  type WorkflowEvent,
} from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createMemoryTraceStore } from "#/pipeline/memory-traces.js";
import { createLivePipeline } from "#/pipeline/live/live.js";
import type { LiveOptions, StopRecord } from "#/pipeline/live/live.types.js";
import { STOP_SUBJECT, stoppedWork } from "#/pipeline/live/stop.js";
import type { EnqueueInput } from "#/scheduler/index.js";
import { openStore, type Store } from "#/store/index.js";
import type { ManualClock } from "#/types.js";

const PR = "github.com/acme-example/shop#9";
const ADA = { kind: "human" as const, id: "ada-admin" };
const SAM = { kind: "agent" as const, id: "sam" };

function team(): TeamConfig {
  const r = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "shop", url: "github.com/acme-example/shop", kind: "primary" }],
    people: [
      { handle: "sam", name: "Sam", role: "developer", model: "sonnet" },
      { handle: "mira", name: "Mira", role: "developer", model: "sonnet" },
    ],
    integrations: {
      chat: { adapter: "slack" },
      vcs: { adapter: "github" },
      runtime: { adapter: "claude-agent-sdk" },
    },
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

const lines: string[] = [];
const logger: Logger = {
  debug() {},
  info: (m: string) => void lines.push(m),
  warn() {},
  error() {},
};

/** ACME-144, assigned to sam, is closed now, as the work state has read it. */
async function setup(status: CanonicalStatus = "canceled", known = true) {
  const clock: ManualClock = manualClock();
  store = await openStore("sqlite::memory:", { now: () => clock.now() });
  const s = store;
  const placed: { id: string; placement: unknown }[] = [];
  const ticket = { status, title: "Duplicate search" };
  const workState = {
    ...createStaticWorkflowState({
      tickets: { "ACME-144": { status, assignee: { id: "sam", kind: "agent" } } },
    }),
    ticket: (key: string) => (known && key === "ACME-144" ? ticket : undefined),
    heard: async () => {},
  };

  const opts: LiveOptions = {
    team: team(),
    store: s,
    workState: workState as never,
    scheduler: {
      async enqueue(input: EnqueueInput) {
        const item = await s.enqueue(input);
        placed.push({ id: item.id, placement: input.placement });
        await input.init?.(item);
        return item;
      },
    },
    executor: { execute: async () => undefined },
    traces: createMemoryTraceStore(),
    clock,
    logger,
  };

  await s.upsertSubject("pr", PR, { ticket: "ACME-144" });
  return { opts, store: s, clock, ticket, placed };
}

const closed = (status: "done" | "canceled", closedBy: WorkflowEvent["actor"]): WorkflowEvent => ({
  type: "ticket.closed",
  subject: { ticket: "ACME-144" },
  actor: { kind: "automation", id: "workstate" },
  data: { status, closedBy, at: "2026-11-02T18:22:16.000Z" },
});

const item = (s: Store, person: string, kind: string, subject: { type: string; ref: string }) =>
  s.enqueue({ person, kind, title: `${kind}: x`, trigger: "human", subject });

const ON_TICKET = { type: "ticket", ref: "ACME-144" };
const NOTICE =
  "ACME-144 was canceled by ada-admin at 18:22 UTC. Stop, and don't open a pull request for it. If the work belongs to another ticket, say which and hand back.";

describe("stopping the work on a closed ticket", () => {
  it("cancels queued work on the ticket and its pull requests, and queues the notice for running work", async () => {
    const { opts, store: s, placed } = await setup();
    const queued = await item(s, "sam", "assigned", ON_TICKET);
    const waiting = await item(s, "sam", "review_feedback", { type: "pr", ref: PR });
    await s.updateItem(waiting.id, { status: "waiting" });
    const running = await item(s, "mira", "ticket_comment", ON_TICKET);
    await s.activateItem(running.id);
    const blocked = await item(s, "sam", "rebase", { type: "pr", ref: PR });
    await s.updateItem(blocked.id, { status: "blocked" });
    const chat = await item(s, "sam", "chat", { type: "chat", ref: "C1:1" });
    const other = await item(s, "sam", "assigned", { type: "ticket", ref: "ACME-7" });
    const unlinked = await item(s, "sam", "doc_feedback", { type: "doc", ref: "d1" });

    const live = createLivePipeline(opts);
    const trace = await live.handle(closed("canceled", ADA), {
      source: "workstate",
      externalId: "c1",
    });

    const line =
      "Canceled: ACME-144 was canceled by ada-admin at 2026-11-02T18:22:16.000Z, before this work started.";

    for (const id of [queued.id, waiting.id]) {
      expect((await s.getItem(id))?.status).toBe("canceled");
      expect((await s.readJournal(id)).map((j) => [j.author, j.text])).toEqual([["office", line]]);
    }

    for (const [id, status] of [
      [running.id, "active"],
      [blocked.id, "blocked"],
      [chat.id, "queued"],
      [other.id, "queued"],
      [unlinked.id, "queued"],
    ] as const) {
      expect((await s.getItem(id))?.status).toBe(status);
    }

    const [notice] = await s.listItems({ person: "mira", status: "queued" });
    expect(notice).toMatchObject({
      kind: "ticket_closed",
      title: "ticket closed: ACME-144 Duplicate search",
      trigger: "automation",
      subject: ON_TICKET,
    });

    expect(placed).toEqual([{ id: notice!.id, placement: "next" }]);
    expect((await s.readJournal(notice!.id)).map((j) => j.text)).toEqual([
      `${NOTICE} (You were working on it in work item ${running.id}.)`,
    ]);

    expect((await s.readJournal(running.id)).map((j) => j.text)).toEqual([
      `ACME-144 was closed while this ran; work item ${notice!.id} tells the agent once it ends.`,
    ]);

    expect(trace?.decisions).toEqual([
      {
        type: "stop",
        policy: "closed_stops_work",
        ticket: "ACME-144",
        notice: NOTICE,
        except: [],
        canceled: [queued.id, waiting.id],
        noticed: [notice!.id],
      },
    ]);

    expect(lines).toContain(`pipeline: canceled work item ${queued.id} for sam: ${line}`);
    expect(await opts.traces.get("workstate:c1")).toEqual(trace);
  });

  it("stops nothing more when the same event is delivered again; titles a ticket it does not know by its key", async () => {
    const { opts, store: s } = await setup("canceled", false);
    const running = await item(s, "mira", "assigned", ON_TICKET);
    await s.activateItem(running.id);
    const live = createLivePipeline(opts);
    await live.handle(closed("canceled", ADA), { source: "workstate", externalId: "c1" });
    const record = (await s.getSubject(STOP_SUBJECT, "ACME-144"))?.data as StopRecord;
    expect((await s.getItem(record.noticed[0]!))?.title).toBe("ticket closed: ACME-144");

    const again = await live.handle(closed("canceled", ADA), {
      source: "workstate",
      externalId: "c1",
    });

    expect(await s.listItems({ person: "mira", status: "queued" })).toHaveLength(1);
    expect(again?.decisions).toMatchObject([{ type: "stop", noticed: record.noticed }]);
  });

  it("leaves the work of the agent who closed its own ticket alone, and stops the others'", async () => {
    const { opts, store: s } = await setup("done");
    const own = await item(s, "sam", "review_feedback", { type: "pr", ref: PR });
    const running = await item(s, "sam", "merge", { type: "pr", ref: PR });
    await s.activateItem(running.id);
    const theirs = await item(s, "mira", "ticket_comment", ON_TICKET);

    await createLivePipeline(opts).handle(closed("done", SAM), {
      source: "workstate",
      externalId: "c2",
    });

    expect((await s.getItem(own.id))?.status).toBe("queued");
    expect(await s.readJournal(running.id)).toEqual([]);
    expect((await s.listItems({ person: "sam", status: "queued" })).map((i) => i.kind)).toEqual([
      "review_feedback",
    ]);

    expect((await s.getItem(theirs.id))?.status).toBe("canceled");
    expect((await s.readJournal(theirs.id))[0]?.text).toBe(
      "Canceled: ACME-144 was closed as done by sam at 2026-11-02T18:22:16.000Z, before this work started.",
    );
  });

  it("names someone when the event does not say who closed the ticket", async () => {
    const { opts, store: s } = await setup();
    const queued = await item(s, "sam", "assigned", ON_TICKET);
    await createLivePipeline(opts).handle(
      { ...closed("canceled", ADA), data: { status: "canceled", at: "2026-11-02T18:22:16.000Z" } },
      { source: "workstate", externalId: "c3" },
    );

    expect((await s.readJournal(queued.id))[0]?.text).toBe(
      "Canceled: ACME-144 was canceled by someone at 2026-11-02T18:22:16.000Z, before this work started.",
    );
  });
});

describe("stoppedWork: the start-time check", () => {
  it("stops an item queued before the stop, while the ticket stays closed", async () => {
    const { opts, store: s, clock, ticket } = await setup();
    const blocked = await item(s, "sam", "assigned", ON_TICKET);
    await s.updateItem(blocked.id, { status: "blocked" });
    const spared = await item(s, "mira", "ticket_comment", ON_TICKET);
    clock.advance(1_000);
    await createLivePipeline(opts).handle(
      { ...closed("done", { kind: "agent", id: "mira" }) },
      { source: "workstate", externalId: "c4" },
    );

    clock.advance(1_000);
    const later = await item(s, "sam", "review_feedback", { type: "pr", ref: PR });
    const notice = await item(s, "sam", "ticket_closed", ON_TICKET);
    const chat = await item(s, "sam", "chat", ON_TICKET);
    const elsewhere = await item(s, "sam", "assigned", { type: "ticket", ref: "ACME-7" });
    const unlinked = await item(s, "sam", "doc_feedback", { type: "doc", ref: "d1" });
    const stopped = stoppedWork({ store: s, workState: opts.workState });

    expect(await stopped(blocked)).toBe(
      "Canceled: ACME-144 was closed as done by mira at 2026-11-02T18:22:16.000Z, before this work started.",
    );

    for (const i of [spared, later, notice, chat, elsewhere, unlinked]) {
      expect(await stopped(i)).toBeUndefined();
    }

    // Open again: the item may start.
    ticket.status = "active";
    expect(await stopped(blocked)).toBeUndefined();
  });
});

describe("stoppedWork: a ticket closed after its round was queued", () => {
  /** ACME-144 entered its closed status now, as the work state read it. */
  const closeNow = (opts: LiveOptions, clock: ManualClock) => {
    const at = clock.now().toISOString();
    Object.assign(opts.workState.ticket("ACME-144")!, { key: "ACME-144", statusSince: at });
    return at;
  };

  it("drops a round queued before the ticket was canceled, though the agent canceled it itself", async () => {
    const { store: s, opts, clock } = await setup("canceled");
    const queued = await item(s, "pia", "assigned", ON_TICKET);
    clock.advance(1_000);
    await createLivePipeline(opts).handle(closed("canceled", { kind: "agent", id: "pia" }), {
      source: "workstate",
      externalId: "c5",
    });

    // The stop spares the agent who canceled it, so its round is still queued.
    expect((await s.getItem(queued.id))?.status).toBe("queued");
    const at = closeNow(opts, clock);
    expect(await stoppedWork({ store: s, workState: opts.workState })(queued)).toBe(
      `Dropped: ACME-144 was canceled at ${at}, after this work was queued and before it started.`,
    );
  });

  it("drops a round on a ticket closed as done after it was queued", async () => {
    const { store: s, opts, clock } = await setup("done");
    const queued = await item(s, "sam", "ticket_comment", ON_TICKET);
    clock.advance(1_000);
    const at = closeNow(opts, clock);

    expect(await stoppedWork({ store: s, workState: opts.workState })(queued)).toBe(
      `Dropped: ACME-144 was closed as done at ${at}, after this work was queued and before it started.`,
    );
  });

  it("starts work that reacts to the close, work queued after it, and work on an open pull request", async () => {
    const { store: s, opts, clock } = await setup("canceled");
    const notice = await item(s, "sam", "ticket_closed", ON_TICKET);
    const milestone = await item(s, "pia", "milestone", ON_TICKET);
    const merged = await item(s, "sam", "merged_feedback", { type: "pr", ref: PR });
    const checks = await item(s, "sam", "merge_checks_failed", { type: "pr", ref: PR });
    const chat = await item(s, "sam", "chat", ON_TICKET);
    const open = "github.com/acme-example/shop#10";
    await s.upsertSubject("pr", open, { ticket: "ACME-144", state: "open" });
    const review = await item(s, "sam", "review_feedback", { type: "pr", ref: open });
    clock.advance(1_000);
    closeNow(opts, clock);

    clock.advance(1_000);
    const after = await item(s, "sam", "ticket_comment", ON_TICKET);
    const stopped = stoppedWork({ store: s, workState: opts.workState });
    for (const i of [notice, milestone, merged, checks, chat, review, after]) {
      expect(await stopped(i)).toBeUndefined();
    }
  });
});

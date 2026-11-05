import type { TeamConfig } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { officeToReview } from "#/hand-back-review.js";
import { createScheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/open.js";
import type { Store, WorkItem } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { schedulerWorkSource } from "#/work-source.js";
import type { PrRecord, TicketRecord } from "#/workstate/index.js";

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_subject_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 2 },
  },
} as unknown as Pick<TeamConfig, "people" | "humans" | "policies">;

const pr = (title: string, state: PrRecord["state"], draft = false) =>
  ({ title, state, draft }) as PrRecord;

/** The work state as the check reads it: tickets by key and the pull requests linked to each. */
function workStateOf() {
  const tickets = new Map<string, Partial<TicketRecord>>();
  const prs = new Map<string, PrRecord[]>();
  const refreshed: [string, unknown][] = [];
  return {
    tickets,
    prs,
    refreshed,
    ticket: (key: string) => tickets.get(key) as TicketRecord | undefined,
    prsOfTicket: (key: string) => prs.get(key) ?? [],
    repoPrs: () => [],
    subTickets: () => [],
    refreshTicket: async (key: string, by?: unknown) => void refreshed.push([key, by]),
    refreshPrsOf: async () => {},
  };
}

describe("officeToReview", () => {
  let store: Store;
  let clock: ManualClock;
  let state: ReturnType<typeof workStateOf>;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
    state = workStateOf();
  });

  afterEach(async () => {
    await store.close();
  });

  /** An item on SHOP-1, started: its run begins now. */
  async function started(kind = "assigned"): Promise<WorkItem> {
    const scheduler = createScheduler({ store, team, clock });
    const item = await scheduler.enqueue({
      person: "sam",
      kind,
      title: "Fix",
      trigger: "human",
      subject: { type: "ticket", ref: "SHOP-1" },
    });

    clock.advance(1000);
    await scheduler.markActive(item.id);
    clock.advance(1000);
    return (await store.getItem(item.id))!;
  }

  const check = (item: WorkItem) => officeToReview({ store, workState: state })(item);

  it("finds nothing for a ticket the run left without a result, after re-reading the ticket", async () => {
    const item = await started();
    state.tickets.set("SHOP-1", { status: "active" });
    state.prs.set("SHOP-1", [pr("Draft", "open", true), pr("Old", "closed")]);
    expect(await check(item)).toEqual([]);
    expect(state.refreshed).toEqual([["SHOP-1", { kind: "agent", id: "sam" }]]);
  });

  it("counts no kind as a result by itself", async () => {
    expect(await check(await started("ticket_comment"))).toEqual([]);
  });

  it("counts a ticket that went to review during the run, not one in review before it", async () => {
    const item = await started();
    const runStart = (await store.listRuns(item.id)).at(-1)!.startedAt;
    state.tickets.set("SHOP-1", { status: "review", statusSince: "2000-01-01T00:00:00.000Z" });
    expect(await check(item)).toEqual([]);
    state.tickets.set("SHOP-1", { status: "review", statusSince: runStart });
    expect(await check(item)).toEqual(["SHOP-1 is review"]);
  });

  it("counts a pull request of the ticket or of the item that is open for review or merged", async () => {
    const item = await started();
    state.prs.set("SHOP-1", [pr("Search", "open")]);
    await store.upsertSubject("pr", "acme/app#2", pr("Merged", "merged"));
    await store.addItemRefs(item.id, [
      { type: "pr", ref: "acme/app#2", role: "inferred", source: "x" },
    ]);

    expect(await check(item)).toEqual([
      "pr acme/app#2 added in the run",
      "pull request Merged is merged",
      "pull request Search is open",
    ]);
  });

  it("counts a document linked during the run, not one linked before it", async () => {
    const before = await started();
    await store.addItemRefs(before.id, [
      { type: "doc", ref: "d0", role: "created", source: "doc_link" },
    ]);

    // A new run of the same item starts after the document was linked.
    clock.advance(1000);
    await store.updateItem(before.id, { status: "queued" });
    await createScheduler({ store, team, clock }).markActive(before.id);
    clock.advance(1000);
    expect(await check(before)).toEqual([]);

    await store.addItemRefs(before.id, [
      { type: "doc", ref: "d1", role: "created", source: "doc_link" },
    ]);

    expect(await check(before)).toEqual(["doc d1 added in the run"]);
  });

  it("counts a ticket closed or canceled", async () => {
    const item = await started();
    state.tickets.set("SHOP-1", { status: "canceled" });
    expect(await check(item)).toEqual(["SHOP-1 is canceled"]);
  });
});

describe("work source: a done hand-back with nothing to review", () => {
  let store: Store;
  let clock: ManualClock;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite://:memory:", { now: () => clock.now() });
  });

  afterEach(async () => {
    await store.close();
  });

  async function handBack(
    result: { status: "done"; toReview?: string[] },
    withState = true,
    kind = "assigned",
  ) {
    const warned: string[] = [];
    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({
      scheduler,
      store,
      team,
      ...(withState ? { workState: workStateOf() } : {}),
      logger: { warn: (m: string) => void warned.push(m) },
    });

    await scheduler.enqueue({
      person: "sam",
      kind,
      title: "Fix",
      trigger: "human",
      subject: { type: "ticket", ref: "SHOP-1" },
    });

    const offer = await source.next("sam");
    const id = offer!.workItem.id;
    await source.handBack("sam", id, { summary: "Waiting on Ada.", links: [], ...result });
    // A retry of the same hand-back keeps what the first one became.
    await source.handBack("sam", id, { summary: "Waiting on Ada.", links: [], ...result });
    return { item: (await store.getItem(id))!, warned };
  }

  it("is taken as blocked, with a warning, when the agent did not check it (an older agent)", async () => {
    const { item, warned } = await handBack({ status: "done" });
    expect(item.status).toBe("blocked");
    expect(warned).toEqual(["a done hand-back left nothing to review; taking it as blocked"]);
  });

  it("is taken as a silent finish for a kind that may finish silently", async () => {
    const { item, warned } = await handBack({ status: "done" }, true, "ticket_comment");
    expect(item.status).toBe("done");
    expect(warned).toEqual(["a done hand-back left nothing to review; taking it as silent"]);
  });

  it("is taken as done when the agent says what it leaves to review", async () => {
    const { item, warned } = await handBack({ status: "done", toReview: ["opened acme/app#1"] });
    expect(item.status).toBe("done");
    expect(warned).toEqual([]);
  });

  it("is taken as it comes without a work state to check against", async () => {
    expect((await handBack({ status: "done" }, false)).item.status).toBe("done");
  });
});

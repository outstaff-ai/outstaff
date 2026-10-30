import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { readOrigin } from "#/chat/origin.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { createOfficeRounds } from "#/office-rounds.js";
import { createScheduler, type Scheduler } from "#/scheduler/index.js";
import { openStore } from "#/store/open.js";
import type { Store, WorkItem } from "#/store/types.js";
import { addFeedback, deliverFeedback, readFeedback } from "#/work-feedback.js";

describe("the office's rounds after a hand-back", () => {
  let store: Store;
  let scheduler: Scheduler;
  let status: Record<string, string>;
  let logged: string[];

  const rounds = (policies?: Record<string, unknown>) =>
    createOfficeRounds({
      store,
      scheduler,
      workState: {
        ticket: (key) => (status[key] ? ({ status: status[key] } as never) : undefined),
      },
      team: teamConfig(policies ? { policies } : {}),
      logger: { info: (m) => void logged.push(m) },
    });

  const item = (over: Partial<Parameters<Scheduler["enqueue"]>[0]> = {}) =>
    scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "assigned: ACME-1",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
      ...over,
    });

  const bare = () =>
    scheduler.enqueue({ person: "sam", kind: "assigned", title: "bare", trigger: "human" });

  const end = async (i: WorkItem, outcome: "done" | "blocked") => {
    await scheduler.markActive(i.id);
    if (outcome === "blocked") {
      await scheduler.block(i.id, "stuck");
    } else {
      await scheduler.finish(i.id, { outcome: "ok", status: "done" });
    }

    return (await store.getItem(i.id))!;
  };

  beforeEach(async () => {
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    scheduler = createScheduler({ store, team: teamConfig(), clock });
    status = {};
    logged = [];
  });

  afterEach(async () => {
    await store.close();
  });

  describe("followUp", () => {
    it("queues one more round, once, for feedback that came after the offer, in the item's chat threads", async () => {
      const first = await item();
      await addFeedback(store, first.id, { actor: "dana", kind: "review", body: "seen" });
      await deliverFeedback(store, first.id);
      await addFeedback(store, first.id, { actor: "dana", kind: "chat", body: "late" });
      await store.addItemRefs(first.id, [
        { type: "ticket", ref: "ACME-1", role: "subject", source: "s" },
      ]);

      const origin = {
        channel: "D1",
        thread: "m1",
        requester: { id: "U1" },
        direct: true,
        participant: true,
        awaitingPlacement: true,
        claimed: ["result:1"],
        also: [
          { channel: "D1", thread: "m2", requester: { id: "U1" }, direct: true, participant: true },
        ],
      };

      await store.upsertSubject("chat_origin", first.id, origin);
      await end(first, "done");
      await rounds().followUp(first.id);
      await rounds().followUp(first.id);

      const next = (await store.listItems({ person: "sam", status: "queued" }))[0]!;
      expect(next).toMatchObject({ kind: "assigned", parentId: first.id, subject: first.subject });
      expect((await readFeedback(store, next.id)).map((f) => f.body)).toEqual(["late"]);
      expect((await store.listItemRefs(next.id)).map((r) => r.ref)).toEqual(["ACME-1"]);
      expect(await readOrigin(store, next.id)).toEqual({
        ...origin,
        awaitingPlacement: false,
        claimed: [],
      });

      expect(await store.listItems({ person: "sam", status: "queued" })).toHaveLength(1);
      expect(logged).toHaveLength(1);
    });

    it("queues nothing without late feedback, for an unknown item, or with policies.feedback.follow_up_round off", async () => {
      const quiet = await bare();
      await rounds().followUp(quiet.id);
      await rounds().followUp("nope");

      const late = await item({ title: "other" });
      await addFeedback(store, late.id, { actor: "dana", kind: "chat", body: "late" });
      await rounds({ feedback: { follow_up_round: false } }).followUp(late.id);
      expect((await store.listItems({ person: "sam" })).map((i) => i.id).toSorted()).toEqual(
        [quiet.id, late.id].toSorted(),
      );
    });

    it("keeps no chat origin for an item without one", async () => {
      const first = await bare();
      await addFeedback(store, first.id, { actor: "dana", kind: "review", body: "late" });
      await end(first, "done");
      await rounds().followUp(first.id);
      const next = (await store.listItems({ person: "sam", status: "queued" }))[0]!;
      expect(next.subject).toBeNull();
      expect(await readOrigin(store, next.id)).toBeUndefined();
    });
  });

  describe("settle", () => {
    it("closes the person's earlier blocked items on a ticket the finished work settled", async () => {
      const stuck = await end(await item(), "blocked");
      await store.upsertSubject("pr", "acme/app#4", { ticket: "ACME-1" });
      const onPr = await end(await item({ subject: { type: "pr", ref: "acme/app#4" } }), "blocked");
      const unblock = await end(await item({ kind: "unblock" }), "blocked");
      const theirs = await end(await item({ person: "pia" }), "blocked");
      const elsewhere = await end(
        await item({ subject: { type: "ticket", ref: "ACME-2" } }),
        "blocked",
      );

      const done = await end(await item(), "done");
      status["ACME-1"] = "review";

      await rounds().settle(done);
      const statusOf = async (i: WorkItem) => (await store.getItem(i.id))!.status;
      expect(await statusOf(stuck)).toBe("canceled");
      expect(await statusOf(onPr)).toBe("canceled");
      expect(await statusOf(unblock)).toBe("blocked");
      expect(await statusOf(theirs)).toBe("blocked");
      expect(await statusOf(elsewhere)).toBe("blocked");
      expect((await store.readJournal(stuck.id)).at(-1)?.text).toBe(
        `Closed: work item ${done.id} finished the work on ACME-1.`,
      );
    });

    it("closes nothing for work that did not settle its ticket", async () => {
      const stuck = await end(await item(), "blocked");
      const answer = await end(await item({ kind: "asked" }), "done");
      const noTicket = await end(await item({ subject: { type: "doc", ref: "d1" } }), "done");
      const unknownPr = await end(
        await item({ subject: { type: "pr", ref: "acme/app#9" } }),
        "done",
      );

      const stillBlocked = await end(await item(), "done");
      status["ACME-1"] = "blocked";

      for (const i of [stuck, answer, noTicket, unknownPr, stillBlocked]) {
        await rounds().settle(i);
      }

      expect((await store.getItem(stuck.id))!.status).toBe("blocked");
    });
  });
});

import type { Member } from "@outstaff/protocol";
import { summarizeItem } from "./item-summary.js";
import { readRoster } from "./messaging/roster.js";
import { ProtocolError } from "./protocol/errors.js";
import type { WorkSource } from "./protocol/source.types.js";
import type { Scheduler } from "./scheduler/index.js";
import type { WorkItem } from "./store/types.js";
import { workMoves } from "./work-moves.js";
import { workStatus } from "./work-status.js";
import { offerBuilder } from "./work-offer.js";
import type { HandBackResult, WorkSourceOptions } from "./work-source.types.js";

/** Subject type that keeps whether the agent accepted an offered item; it must survive a restart. */
export const OFFER_SUBJECT = "offer";

const OPEN = new Set(["queued", "active", "waiting", "blocked"]);

/** The states a hand-back that is retried finds the item in, after the first one went through. */
const HANDED_BACK = new Set(["done", "waiting", "blocked"]);

interface OfferState {
  accepted: boolean;
}

/** The journal entry of a hand-back: the agent's summary and the links it gave. */
function handBackNote(result: HandBackResult): string {
  const links = result.links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`);
  return [result.summary, ...(links.length > 0 ? ["", "Links:", ...links] : [])].join("\n");
}

/** Ends the run the way the agent handed it back. */
async function settle(scheduler: Scheduler, id: string, result: HandBackResult) {
  if (result.status === "blocked") {
    return scheduler.block(id, result.summary);
  }

  if (result.status === "interrupted") {
    return scheduler.interrupt(id, result.summary);
  }

  return scheduler.finish(id, { outcome: result.summary, status: result.status });
}

/** A hand-back the office already took: an interruption, or the item already left `active` for it. */
const retried = (item: WorkItem, result: HandBackResult) =>
  result.status === "interrupted" || HANDED_BACK.has(item.status);

/** The protocol's `WorkSource` over the real scheduler and store. All its state is in the store. */
export function schedulerWorkSource(opts: WorkSourceOptions): WorkSource {
  const { scheduler, store } = opts;

  const own = async (person: string, id: string): Promise<WorkItem> => {
    const item = await store.getItem(id);
    if (!item || item.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${id} for ${person}.`);
    }

    return item;
  };

  const stateOf = async (id: string): Promise<OfferState> =>
    ((await store.getSubject(OFFER_SUBJECT, id))?.data as OfferState | undefined) ?? {
      accepted: false,
    };

  const offerOf = offerBuilder(store, opts.ports, {
    team: opts.team,
    ...(opts.traces ? { traces: opts.traces } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const summaryOf = (item: WorkItem, current?: string) => summarizeItem(store, item, current);

  return {
    async outstanding(person) {
      const active = await store.listItems({ person, status: "active" });
      return Promise.all(
        active.map(async (item) => {
          const accepted = (await stateOf(item.id)).accepted;
          return { offer: await offerOf(item, !accepted), accepted };
        }),
      );
    },

    async next(person) {
      const item = await scheduler.next(person);
      if (!item) {
        return undefined;
      }

      const started = await scheduler.markActive(item.id);
      if (!started.started) {
        if (started.blocked) {
          await opts.onBlocked?.(started.blocked);
        }

        return undefined;
      }

      await opts.onStarted?.(started.item);
      await store.upsertSubject(OFFER_SUBJECT, item.id, { accepted: false });
      return offerOf(started.item);
    },

    async accept(person, id, on) {
      const item = await own(person, id);
      if (item.status !== "active") {
        throw new ProtocolError("invalid", `Work item ${id} is ${item.status}, not offered.`);
      }

      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: true });
      await store.tagRun(id, on);
    },

    async decline(person, id, reason) {
      const item = await own(person, id);
      // Offered or accepted: an agent that restarted drops what it had accepted too.
      if (item.status !== "active") {
        throw new ProtocolError("invalid", `Work item ${id} is not running.`);
      }

      // The item stays as it is (same run, attempt, journal and session) and is only offered again.
      await store.appendJournal(id, person, `Gave the item back: ${reason}`);
      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: false });
      await scheduler.heartbeat(id);
      opts.notify?.(person);
    },

    async heartbeat(person, id) {
      if (id) {
        await own(person, id);
        await scheduler.heartbeat(id);
      }
    },

    async progress(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, `Progress: ${text}`);
      await scheduler.heartbeat(id);
    },

    async setSession(person, id, sessionId, model) {
      await own(person, id);
      await store.updateItem(id, { sessionId });
      if (model) {
        await store.tagRun(id, { model });
      }
    },

    async journal(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, text);
    },

    async handBack(person, id, result) {
      const item = await own(person, id);
      // A retried hand-back finds the item already finished and only repeats the follow-up.
      if (item.status === "active") {
        await store.appendJournal(id, person, handBackNote(result));
        await settle(scheduler, id, result);
      } else if (!retried(item, result)) {
        throw new ProtocolError("invalid", `Work item ${id} is ${item.status}, not running.`);
      }

      await opts.onHandedBack?.((await store.getItem(id)) ?? item, result);
    },

    async fail(person, id, reason) {
      const item = await own(person, id);
      if (item.status !== "active") {
        return;
      }

      await store.appendJournal(id, person, `The run failed: ${reason}`);
      const failed = await scheduler.fail(id, reason);
      if (failed.blocked) {
        await opts.onBlocked?.(failed.blocked);
      }
    },

    async roster(): Promise<Member[]> {
      return (
        await readRoster({
          store,
          team: opts.team,
          ...(opts.roles ? { roles: opts.roles } : {}),
        })
      ).members;
    },

    async list(person, q) {
      const items = (await store.listItems({ person }))
        .filter((i) => OPEN.has(i.status))
        .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      return Promise.all(items.map((i) => summaryOf(i, q.workItemId)));
    },

    ...workMoves(opts, own, summaryOf),
    ...workStatus(store),
  };
}

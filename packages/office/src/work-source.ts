import type { Member } from "@outstaff/protocol";
import { placeQueued } from "./chat/placement.js";
import { readOrigin } from "./chat/origin.js";
import { summarizeItem } from "./item-summary.js";
import { readRoster } from "./messaging/roster.js";
import { ProtocolError } from "./protocol/errors.js";
import type { WorkSource } from "./protocol/source.types.js";
import type { WorkItem } from "./store/types.js";
import { offerBuilder } from "./work-offer.js";
import type { WorkSourceOptions } from "./work-source.types.js";

/** Subject type that keeps whether the agent accepted an offered item; it must survive a restart. */
export const OFFER_SUBJECT = "offer";

const OPEN = new Set(["queued", "active", "waiting", "blocked"]);

interface OfferState {
  accepted: boolean;
}

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

  const offerOf = offerBuilder(store, opts.ports);
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

    async accept(person, id) {
      const item = await own(person, id);
      if (item.status !== "active") {
        throw new ProtocolError("invalid", `Work item ${id} is ${item.status}, not offered.`);
      }

      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: true });
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

    async setSession(person, id, sessionId) {
      await own(person, id);
      await store.updateItem(id, { sessionId });
    },

    async journal(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, text);
    },

    async handBack(person, id, result) {
      const item = await own(person, id);
      // A retried hand-back finds the item already finished and only repeats the follow-up.
      if (item.status === "active") {
        const links = result.links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`);
        await store.appendJournal(
          id,
          person,
          [result.summary, ...(links.length > 0 ? ["", "Links:", ...links] : [])].join("\n"),
        );

        if (result.status === "blocked") {
          await scheduler.block(id, result.summary);
        } else if (result.status === "interrupted") {
          await scheduler.interrupt(id, result.summary);
        } else {
          await scheduler.finish(id, { outcome: result.summary, status: result.status });
        }
      } else if (
        result.status !== "interrupted" &&
        item.status !== "done" &&
        item.status !== "waiting" &&
        item.status !== "blocked"
      ) {
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

    async place(person, id, position, relativeTo) {
      const item = await own(person, id);
      if (item.status !== "queued") {
        throw new ProtocolError(
          "invalid",
          `Work item ${id} is ${item.status}; only queued items can be placed.`,
        );
      }

      if ((position === "before" || position === "after") && !relativeTo) {
        throw new ProtocolError("invalid", `Say which item it goes ${position}.`);
      }

      try {
        await placeQueued(
          { store, scheduler },
          id,
          position === "before" || position === "after"
            ? position === "before"
              ? { before: relativeTo! }
              : { after: relativeTo! }
            : position,
        );
      } catch (error) {
        throw new ProtocolError("invalid", error instanceof Error ? error.message : String(error));
      }

      const origin = await readOrigin(store, id);
      if (origin?.awaitingPlacement) {
        await store.upsertSubject("chat_origin", id, { ...origin, awaitingPlacement: false });
      }

      await store.appendJournal(
        id,
        person,
        `Placed ${position}${relativeTo ? ` ${relativeTo}` : ""}.`,
      );

      opts.notify?.(person);
      return summaryOf((await store.getItem(id)) ?? item, id);
    },

    async move(person, id, status) {
      const item = await own(person, id);
      if (status === "queued") {
        if (item.status !== "blocked" && item.status !== "waiting") {
          throw new ProtocolError(
            "invalid",
            `Work item ${id} is ${item.status}; it cannot be queued.`,
          );
        }

        await store.appendJournal(id, person, "Queued again by the agent.");
        const updated = await store.updateItem(id, { status: "queued" });
        opts.notify?.(person);
        return summaryOf(updated, id);
      }

      if (status === "blocked") {
        if (item.status !== "queued" && item.status !== "waiting") {
          throw new ProtocolError(
            "invalid",
            `Work item ${id} is ${item.status}; it cannot be blocked.`,
          );
        }

        await scheduler.block(id, `${person} blocked it.`);
        return summaryOf((await store.getItem(id)) ?? item, id);
      }

      if (item.status === "done" || item.status === "canceled") {
        throw new ProtocolError("invalid", `Work item ${id} is already ${item.status}.`);
      }

      if (item.status === "active") {
        await scheduler.finish(id, { outcome: `canceled by ${person}`, status: "canceled" });
      } else {
        await store.updateItem(id, { status: "canceled" });
      }

      await store.appendJournal(id, person, "Canceled by the agent.");
      return summaryOf((await store.getItem(id)) ?? item, id);
    },
  };
}

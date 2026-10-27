import type { WorkSummary } from "@outstaff/protocol";
import { placeQueued } from "./chat/placement.js";
import { readOrigin } from "./chat/origin.js";
import { ProtocolError } from "./protocol/errors.js";
import type { WorkSource } from "./protocol/source.types.js";
import type { Placement } from "./scheduler/types.js";
import type { WorkItem } from "./store/types.js";
import type { WorkSourceOptions } from "./work-source.types.js";

type Position = Parameters<WorkSource["place"]>[2];

const REQUEUABLE = new Set(["blocked", "waiting"]);
const BLOCKABLE = new Set(["queued", "waiting"]);
const ENDED = new Set(["done", "canceled"]);

/** Where to place the item; `before` and `after` need the item they are relative to. */
function placementOf(position: Position, relativeTo: string | undefined): Placement {
  if (position !== "before" && position !== "after") {
    return position;
  }

  if (!relativeTo) {
    throw new ProtocolError("invalid", `Say which item it goes ${position}.`);
  }

  return position === "before" ? { before: relativeTo } : { after: relativeTo };
}

const invalid = (error: unknown) =>
  new ProtocolError("invalid", error instanceof Error ? error.message : String(error));

/** An agent placing or moving its own items. `own` refuses an item that is not the person's. */
export function workMoves(
  opts: WorkSourceOptions,
  own: (person: string, id: string) => Promise<WorkItem>,
  summaryOf: (item: WorkItem, current?: string) => Promise<WorkSummary>,
): Pick<WorkSource, "place" | "move"> {
  const { scheduler, store } = opts;

  /** The item as it is now, for the answer. */
  const summaryNow = async (item: WorkItem) =>
    summaryOf((await store.getItem(item.id)) ?? item, item.id);

  /** A placed item is no longer waiting for its requester to say where it goes. */
  const placed = async (id: string) => {
    const origin = await readOrigin(store, id);
    if (origin?.awaitingPlacement) {
      await store.upsertSubject("chat_origin", id, { ...origin, awaitingPlacement: false });
    }
  };

  const requeue = async (person: string, item: WorkItem) => {
    if (!REQUEUABLE.has(item.status)) {
      throw new ProtocolError(
        "invalid",
        `Work item ${item.id} is ${item.status}; it cannot be queued.`,
      );
    }

    await store.appendJournal(item.id, person, "Queued again by the agent.");
    const updated = await store.updateItem(item.id, { status: "queued" });
    opts.notify?.(person);
    return summaryOf(updated, item.id);
  };

  const block = async (person: string, item: WorkItem) => {
    if (!BLOCKABLE.has(item.status)) {
      throw new ProtocolError(
        "invalid",
        `Work item ${item.id} is ${item.status}; it cannot be blocked.`,
      );
    }

    await scheduler.block(item.id, `${person} blocked it.`);
    return summaryNow(item);
  };

  const cancel = async (person: string, item: WorkItem) => {
    if (ENDED.has(item.status)) {
      throw new ProtocolError("invalid", `Work item ${item.id} is already ${item.status}.`);
    }

    if (item.status === "active") {
      await scheduler.finish(item.id, { outcome: `canceled by ${person}`, status: "canceled" });
    } else {
      await store.updateItem(item.id, { status: "canceled" });
    }

    await store.appendJournal(item.id, person, "Canceled by the agent.");
    return summaryNow(item);
  };

  const moves = { queued: requeue, blocked: block, canceled: cancel };

  return {
    async place(person, id, position, relativeTo) {
      const item = await own(person, id);
      if (item.status !== "queued") {
        throw new ProtocolError(
          "invalid",
          `Work item ${id} is ${item.status}; only queued items can be placed.`,
        );
      }

      const placement = placementOf(position, relativeTo);
      await placeQueued({ store, scheduler }, id, placement).catch((error: unknown) => {
        throw invalid(error);
      });

      await placed(id);
      await store.appendJournal(
        id,
        person,
        `Placed ${position}${relativeTo ? ` ${relativeTo}` : ""}.`,
      );

      opts.notify?.(person);
      return summaryNow(item);
    },

    async move(person, id, status) {
      return moves[status](person, await own(person, id));
    },
  };
}

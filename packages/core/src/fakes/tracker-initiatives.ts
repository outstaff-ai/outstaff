import {
  PortError,
  type Initiative,
  type InitiativeChanges,
  type InitiativeFilter,
  type InitiativeRef,
  type NewInitiative,
} from "#/ports/index.js";
import type { FakeTracker } from "./types.js";

/**
 * The fake's initiatives (`initiativeList`, by id, in the order they were made) and the initiative each ticket is in
 * (`ticketInitiatives`, ticket key to initiative id).
 */
export function fakeInitiatives(now: () => Date, base: string) {
  const initiativeList: FakeTracker["initiativeList"] = new Map();
  const ticketInitiatives: FakeTracker["ticketInitiatives"] = new Map();

  const named = (id: string): Initiative => {
    const found = initiativeList.get(id);
    if (!found) {
      throw new PortError("not_found", `Initiative ${id} not found.`);
    }

    return found;
  };

  const ref = (key: string): InitiativeRef | null => {
    const id = ticketInitiatives.get(key);
    return id === undefined ? null : { id, title: named(id).title };
  };

  return {
    initiativeList,
    ticketInitiatives,
    initiativeRef: ref,

    /** Puts the ticket in the initiative, which must exist; `null` takes it out of its initiative. */
    place(key: string, id: string | null) {
      if (id === null) {
        ticketInitiatives.delete(key);
        return;
      }

      named(id);
      ticketInitiatives.set(key, id);
    },

    async initiatives(filter: InitiativeFilter = {}) {
      return structuredClone(
        [...initiativeList.values()].filter(
          (i) => !filter.status || filter.status.includes(i.status),
        ),
      );
    },

    async getInitiative(id: string) {
      return structuredClone(named(id));
    },

    async createInitiative(input: NewInitiative) {
      if (!input.title.trim()) {
        throw new PortError("invalid", "Title is required.");
      }

      const id = String(initiativeList.size + 1);
      const made: Initiative = {
        id,
        title: input.title,
        description: input.description ?? "",
        status: input.status ?? "planned",
        url: `${base}/initiative/${id}`,
        updatedAt: now().toISOString(),
      };

      initiativeList.set(id, made);
      return structuredClone(made);
    },

    async updateInitiative(id: string, changes: InitiativeChanges) {
      const found = named(id);
      if (changes.title !== undefined && !changes.title.trim()) {
        throw new PortError("invalid", "Title is required.");
      }

      Object.assign(found, structuredClone(changes), { updatedAt: now().toISOString() });
      return structuredClone(found);
    },
  };
}

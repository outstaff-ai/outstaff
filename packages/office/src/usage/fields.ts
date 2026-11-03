import { USAGE_FIELDS } from "@outstaff/core";
import type { WorkItem } from "#/store/types.js";
import type { UsageFields, UsageFieldsOptions } from "./fields.types.js";
import { ticketUsage } from "./ticket-usage.js";

/** Subject type keeping the values last sent to a ticket's fields, so an unchanged total is not written again. */
export const USAGE_FIELDS_SUBJECT = "usage_fields";

/** Parents above a ticket that get its roll-up, at most. */
const MAX_PARENTS = 3;

interface Written {
  tokens: number;
  costUsd: number;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

/** The tickets a work item names: its subject and its references. */
async function ticketsOf(opts: UsageFieldsOptions, item: WorkItem): Promise<string[]> {
  const refs = await opts.store.listItemRefs(item.id);
  const subject = item.subject?.type === "ticket" ? [item.subject.ref] : [];
  return [...new Set([...subject, ...refs.filter((r) => r.type === "ticket").map((r) => r.ref)])];
}

/**
 * Writes each ticket's totals into its usage fields, with the `act` mechanism, as the agent whose round it was: the
 * office's own tracker account only reads. A ticket waits `debounceMs` after its last round, so a burst writes once;
 * after a ticket is written, its parent is due the same way, with the roll-up of its sub-tickets.
 */
export function createUsageFields(opts: UsageFieldsOptions): UsageFields {
  const { store, clock, log } = opts;
  const pending = new Map<string, { person: string; depth: number; cancel: () => void }>();

  async function parentOf(ticket: string): Promise<string | undefined> {
    try {
      return (await opts.tracker.getIssue(ticket)).parent;
    } catch (err) {
      log.warn("could not read the parent of a ticket", { ticket, error: String(err) });
      return undefined;
    }
  }

  async function write(ticket: string, person: string): Promise<void> {
    const { total } = await ticketUsage({ store, tracker: opts.tracker, log }, ticket);
    const next: Written = { tokens: total.tokens, costUsd: cents(total.costUsd) };
    const was = (await store.getSubject(USAGE_FIELDS_SUBJECT, ticket))?.data as Written | undefined;
    if (was?.tokens === next.tokens && was.costUsd === next.costUsd) {
      return;
    }

    await opts.acts.send(person, {
      id: `usage:${ticket}:${clock.now().toISOString()}`,
      ops: [
        { op: "set_field", ticket, field: USAGE_FIELDS.tokens.name, value: next.tokens },
        { op: "set_field", ticket, field: USAGE_FIELDS.cost.name, value: next.costUsd },
      ],
    });

    await store.upsertSubject(USAGE_FIELDS_SUBJECT, ticket, next);
  }

  async function flush(ticket: string, person: string, depth: number): Promise<void> {
    pending.delete(ticket);
    try {
      await write(ticket, person);
      const parent = depth < MAX_PARENTS ? await parentOf(ticket) : undefined;
      if (parent) {
        due(parent, person, depth + 1);
      }
    } catch (err) {
      log.warn("could not write the usage fields of a ticket", { ticket, error: String(err) });
    }
  }

  /** The ticket is written once it has been quiet for `debounceMs`, as the agent of its latest round. */
  function due(ticket: string, person: string, depth: number): void {
    pending.get(ticket)?.cancel();
    const cancel = clock.setTimeout(() => void flush(ticket, person, depth), opts.debounceMs);
    pending.set(ticket, { person, depth, cancel });
  }

  return {
    async touched(item) {
      for (const ticket of await ticketsOf(opts, item)) {
        due(ticket, item.person, 0);
      }
    },

    stop() {
      for (const p of pending.values()) {
        p.cancel();
      }

      pending.clear();
    },
  };
}

import {
  usageSettings,
  type Capability,
  type Logger,
  type TeamConfig,
  type Tracker,
} from "@outstaff/core";
import type { SessionUsageReport, TicketUsage } from "@outstaff/protocol";
import type { OfficeOptions } from "./office.types.js";
import type { ActDesk } from "./pipeline/act/act.types.js";
import { ProtocolError } from "./protocol/errors.js";
import type { TicketUsageDesk } from "./protocol/source.types.js";
import type { Store, WorkItem } from "./store/types.js";
import type { Clock } from "./types.js";
import { createUsageFields, recordRoundUsage, ticketUsage } from "./usage/index.js";

const DEFAULT_DEBOUNCE_MS = 30_000;

/** How long a ticket stays quiet before its fields are written; the e2e poll knob shortens it with the polls. */
const debounceOf = (o: OfficeOptions) =>
  o.usageFieldsDebounceMs ??
  (o.pollIntervalMs === undefined ? DEFAULT_DEBOUNCE_MS : 2 * o.pollIntervalMs);

/**
 * The office's part in usage tracking (`usage` in the team file): each round's usage goes on its run, the tickets it
 * touched get their totals written into the tracker's fields by the agent, and `ost usage` reads a ticket's totals.
 */
export function officeUsage(deps: {
  team: Pick<TeamConfig, "usage">;
  store: Store;
  ports: { tracker?: Tracker | undefined };
  acts: Pick<ActDesk, "send">;
  capabilities: readonly Capability[];
  clock: Clock;
  log: Logger;
  options: OfficeOptions;
}): {
  recordUsage?: (item: WorkItem, usage: SessionUsageReport[]) => Promise<void>;
  ticketUsage: TicketUsageDesk;

  /** For the office link; absent when the team does not track usage. */
  link: { ticket(key: string): Promise<TicketUsage> } | undefined;
  stop: () => void;
} {
  const { store, log } = deps;
  const { tracker } = deps.ports;
  const { trackCost, trackerFields } = usageSettings(deps.team);
  const fields =
    trackerFields && tracker && deps.capabilities.includes("tracker.fields")
      ? createUsageFields({
          store,
          tracker,
          acts: deps.acts,
          clock: deps.clock,
          log,
          debounceMs: debounceOf(deps.options),
        })
      : undefined;

  return {
    ...(trackCost
      ? {
          async recordUsage(item, usage) {
            if (await recordRoundUsage(store, item.id, usage)) {
              await fields?.touched(item);
            }
          },
        }
      : {}),

    ticketUsage: {
      async read(ticket) {
        if (!trackCost) {
          throw new ProtocolError("invalid", "This team does not track usage (usage.track_cost).");
        }

        return ticketUsage({ store, tracker, log }, ticket);
      },
    },

    link: trackCost ? { ticket: (key) => ticketUsage({ store, tracker, log }, key) } : undefined,
    stop: () => fields?.stop(),
  };
}

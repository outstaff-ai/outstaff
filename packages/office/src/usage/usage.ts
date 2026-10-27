import { runtimeOf, silentLogger, type TeamConfig } from "@outstaff/core";
import type { UsageWindowReport } from "@outstaff/protocol";
import { peakWindow } from "#/scheduler/policy.js";
import type { UsageTracker, UsageTrackerOptions } from "./types.js";

export const USAGE_SUBJECT = "usage";
export const DEFAULT_STALE_AFTER_MINUTES = 30;

interface UsageRecord {
  windows: UsageWindowReport[];
  reportedAt: string;

  /** Who sent the report, when it was sent for a shared subscription. */
  via?: string;
}

/**
 * The people whose limit is the same as `person`'s, the person included: their `policies.usage.shared` group, kept to
 * the members on the person's runtime, since a group shares one credential and a credential belongs to one runtime.
 */
export function usageGroupOf(
  team: Pick<TeamConfig, "policies" | "people" | "integrations">,
  person: string,
): readonly string[] {
  const group = team.policies?.usage?.shared?.find((g) => g.includes(person));
  if (!group) {
    return [person];
  }

  const runtimes = new Map(team.people.map((p) => [p.handle, runtimeOf(team, p).adapter]));
  const mine = runtimes.get(person);
  return group.filter((member) => runtimes.get(member) === mine);
}

export function createUsageTracker(opts: UsageTrackerOptions): UsageTracker {
  const { store, team, clock } = opts;
  const log = opts.logger ?? silentLogger;
  const staleMs = (opts.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES) * 60_000;
  const known = new Set(team.people.map((p) => p.handle));

  // One warning per person until fresh data arrives, not one per scheduling decision.
  const warned = new Set<string>();

  /** Windows that have not reset yet, from a report that is not stale; undefined when unknown. */
  async function current(person: string): Promise<UsageWindowReport[] | undefined> {
    const record = (await store.getSubject(USAGE_SUBJECT, person))?.data as UsageRecord | undefined;
    const now = clock.now().getTime();
    if (!record || now - Date.parse(record.reportedAt) > staleMs) {
      return undefined;
    }

    // A window past its reset time has started over, so its old figure no longer counts.
    return record.windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now);
  }

  return {
    async report(person, windows) {
      const record: UsageRecord = { windows: [...windows], reportedAt: clock.now().toISOString() };
      for (const member of usageGroupOf(team, person)) {
        if (known.has(member)) {
          warned.delete(member);
          await store.upsertSubject(USAGE_SUBJECT, member, {
            ...record,
            ...(member === person ? {} : { via: person }),
          });
        }
      }
    },

    async windows(person) {
      const windows = await current(person);
      if (!windows) {
        if (!warned.has(person)) {
          warned.add(person);
          log.warn("no recent usage report; the usage policy is not applied", { person });
        }

        return [];
      }

      return windows;
    },

    async summary(person) {
      const peak = peakWindow((await current(person)) ?? []);
      return peak
        ? {
            window: peak.name,
            utilization: peak.utilization,
            ...(peak.resetsAt ? { resetsAt: peak.resetsAt } : {}),
          }
        : undefined;
    },
  };
}

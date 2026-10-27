import type { Logger, TeamConfig } from "@outstaff/core";
import type { MemberUsage, UsageWindowReport } from "@outstaff/protocol";
import type { UsageSource } from "#/scheduler/types.js";
import type { Store } from "#/store/types.js";
import type { Clock } from "#/types.js";

export interface UsageTrackerOptions {
  store: Pick<Store, "upsertSubject" | "getSubject">;
  team: Pick<TeamConfig, "policies" | "people" | "integrations">;
  clock: Clock;
  logger?: Logger;

  /** A report older than this counts as unknown. Default 30 minutes. */
  staleAfterMinutes?: number;
}

export interface UsageTracker extends UsageSource {
  /** Stores the latest windows of the reporter and of everyone who shares its subscription. */
  report(person: string, windows: readonly UsageWindowReport[]): Promise<void>;

  /** The busiest current window of the person, or undefined when nothing fresh is known. */
  summary(person: string): Promise<MemberUsage | undefined>;
}

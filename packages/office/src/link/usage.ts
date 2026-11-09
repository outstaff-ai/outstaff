import { MAX_PERIOD_DAYS, type LinkRequest, type LinkResponse } from "@outstaff/protocol";
import { localDateIn, periodUsage as countPeriod, teamUsage, type Period } from "#/usage/index.js";
import type { OfficeLinkOptions } from "./link.types.js";

type Params<M extends LinkRequest["method"]> = Extract<LinkRequest, { method: M }>["params"];

const invalid = (id: string, message: string): LinkResponse => ({
  id,
  error: { code: "invalid", message },
});

const untracked = (id: string): LinkResponse =>
  invalid(id, "This team does not track usage (usage.track_cost).");

/** The `usage` method: what runs that finished in the window used, per person and per day. */
export async function usage(
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"usage">,
): Promise<LinkResponse> {
  if (!opts.usage) {
    return untracked(id);
  }

  const window = {
    since: params?.since,
    until: params?.until,
    now: opts.clock.now().toISOString(),
  };

  return { id, result: await teamUsage(opts.store, window) };
}

/** The `ticket_usage` method: one ticket's usage, its sub-tickets rolled up. */
export async function ticketUsage(
  opts: OfficeLinkOptions,
  id: string,
  ticket: string,
): Promise<LinkResponse> {
  return opts.usage ? { id, result: await opts.usage.ticket(ticket) } : untracked(id);
}

const knownZone = (tz: string) => {
  try {
    localDateIn(tz);
    return true;
  } catch {
    return false;
  }
};

/** Why the period can't be counted; undefined when it can. */
function problemOf(from: number, to: number, tz: string): string | undefined {
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
    return "`from` and `to` must be times, `from` before `to`.";
  }

  if (to - from > MAX_PERIOD_DAYS * 24 * 3600 * 1000) {
    return `A period is at most ${MAX_PERIOD_DAYS} days.`;
  }

  return knownZone(tz) ? undefined : `Unknown time zone: ${tz}.`;
}

/** The period asked for, or why it can't be counted. */
function periodOf(params: Params<"period_usage">, now: number): Period | string {
  const from = Date.parse(params.from);
  const to = params.to === undefined ? now : Date.parse(params.to);
  const tz = params.tz ?? "UTC";
  return (
    problemOf(from, to, tz) ?? { from, to, tz, groupBy: [...new Set(params.groupBy ?? [])], now }
  );
}

/** The `period_usage` method: tokens, cost and run time of a period, split at its days or months in its time zone. */
export async function periodUsage(
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"period_usage">,
): Promise<LinkResponse> {
  const period = periodOf(params, opts.clock.now().getTime());
  return typeof period === "string"
    ? invalid(id, period)
    : { id, result: await countPeriod(opts.store, period) };
}

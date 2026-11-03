import type { LinkRequest, LinkResponse } from "@outstaff/protocol";
import { teamUsage } from "#/usage/index.js";
import type { OfficeLinkOptions } from "./link.types.js";

type Params<M extends LinkRequest["method"]> = Extract<LinkRequest, { method: M }>["params"];

const untracked = (id: string): LinkResponse => ({
  id,
  error: { code: "invalid", message: "This team does not track usage (usage.track_cost)." },
});

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

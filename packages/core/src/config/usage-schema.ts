import { z } from "zod";
import { d } from "./schema-meta.js";

export const usageSettingsSchema = z
  .strictObject({
    track_cost: z
      .boolean()
      .default(true)
      .meta(
        d(
          "Record the tokens and cost of every run and total them per ticket, sub-tickets rolled up into their parent. The cost is what the runs would cost at API prices (API-equivalent), not what a subscription bills. Default on.",
        ),
      ),
    tracker_fields: z
      .boolean()
      .default(true)
      .meta(
        d(
          'Show each ticket\'s totals in two custom fields of the tracker, "Agent tokens" and "Agent cost, USD (API-equivalent)", written by the agent whose run it was. Needs a tracker with tracker.fields. Off keeps the totals in the office only. Default on.',
        ),
      ),
  })
  .meta(d("Tokens and cost of agent work, per run and per ticket."));

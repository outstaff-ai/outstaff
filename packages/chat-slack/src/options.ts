import { z } from "zod";

// The tokens come from secrets; nothing needs configuring.
export const slackOptions = z.strictObject({});

export type SlackOptions = z.output<typeof slackOptions>;

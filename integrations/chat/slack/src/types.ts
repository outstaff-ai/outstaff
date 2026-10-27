import type { z } from "zod";
import type { SlackSocket, SlackWeb } from "./api.js";
import type { slackOptions } from "./options.js";

export type SlackOptions = z.output<typeof slackOptions>;

/** Replace the web or socket client; tests inject fakes, production builds the real ones from secrets. */
export interface SlackDeps {
  web?: SlackWeb;
  socket?: SlackSocket;
}

export interface Sender {
  bot: boolean;
  trusted: boolean;
  name?: string;
}

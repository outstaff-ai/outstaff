import type { ChatMessage, Logger } from "@outstaff/core";
import type { z } from "zod";
import type { SlackMessage, SlackSocket, SlackWeb } from "./api.js";
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

/** What catching up needs of the chat adapter. */
export interface CatchUpDeps {
  web: SlackWeb;
  log: Logger;
  botUserId(): Promise<string>;

  /** The direct message channels with the team's humans. */
  directs(): Promise<string[]>;
  toMessage(channel: string, m: SlackMessage): Promise<ChatMessage>;

  /** False for a message this process has delivered already; marks it delivered. */
  remember(key: string): boolean;
}

/** One conversation to catch up on, and where it left off (ISO-8601). */
export interface MissedConversation {
  channel: string;
  thread?: string;
  after: string;
}

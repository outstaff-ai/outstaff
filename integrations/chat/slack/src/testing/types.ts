import type { ChatSeed, InboundMessage } from "@outstaff/core/contracts";
import type { SlackEvent, SlackSocket, SlackUser, SlackWeb } from "#/api.js";

export interface FakeSlack {
  web: SlackWeb;
  socket: SlackSocket & { started: boolean };
  seed: ChatSeed;

  /** What a download from Slack's file host sees: the bytes of every file seeded, by file id. */
  files: Map<string, NonNullable<InboundMessage["files"]>[number]>;

  /** The file host: serves the seeded files to the bot token only, like `url_private_download`. */
  fetch: typeof fetch;

  /** Every chat.postMessage, in order. */
  posts: Pick<Parameters<SlackWeb["chat"]["postMessage"]>[0], "channel" | "text" | "thread_ts">[];
  reactions: Parameters<SlackWeb["reactions"]["add"]>[0][];
  views: Parameters<SlackWeb["views"]["publish"]>[0][];
  usersInfoCalls: string[];
  users: Map<string, SlackUser>;

  /** Deliver a raw Events API event to the adapter and wait for it to finish. */
  emit(event: SlackEvent): Promise<void>;

  /** A message from `user` in a direct channel, as Slack delivers it. */
  directMessage(user: string, text: string, extra?: Partial<SlackEvent>): Promise<void>;
}

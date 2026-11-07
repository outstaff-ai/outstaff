/** A file shared in a message. The adapter fills `url` with whatever it needs to fetch the bytes in `Chat.download`. */
export interface ChatFile {
  id: string;
  name: string;
  mimetype: string;

  /** Size in bytes. */
  size: number;
  url: string;
}

export interface ChatMessage {
  id: string;
  channel: string;
  thread?: string;
  author: { id: string; name?: string; trusted: boolean; bot: boolean };
  text: string;
  at: string;

  /** The conversation is a direct message (a private chat). Adapters set it; absent means a channel. */
  direct?: boolean;

  /** Files shared in the message: data from the author, like the text. Absent when there are none. */
  files?: ChatFile[];
}

/** Where catching up starts in one conversation: after the last message the office took in there. */
export interface ChatCursor {
  channel: string;

  /** The thread; absent for the top level of the channel or direct message. */
  thread?: string | undefined;

  /** When that message was written (ISO-8601). */
  at: string;
}

export interface ChatMissedOptions {
  /** The conversations the office took messages in from, each with where it left off. */
  cursors: ChatCursor[];

  /** Nothing written before this is returned (ISO-8601), however far back a conversation's cursor is. */
  since: string;

  /** The most messages returned per conversation: the latest ones. */
  limit: number;
}

/** One conversation's messages written to the agent while it was not listening. */
export interface ChatMissed {
  channel: string;
  thread?: string;
  direct?: boolean;

  /** What `start` would have delivered, oldest first: trusted humans' requests after the cursor, at most `limit`. */
  messages: ChatMessage[];

  /** Requests after the cursor that are not returned: written before `since`, or older than the latest `limit`. */
  skipped: number;
}

export interface AgentProfile {
  name: string;
  role: string;

  /** One line on what the agent does. */
  description?: string;
  model?: string;
  status: "idle" | "working" | "paused";

  /** The active item, linked when `url` is given. */
  current?: { title: string; url?: string };

  /** When the agent last worked (ISO-8601). The adapter shows it in the viewer's timezone where it knows it. */
  lastActiveAt?: string;

  /** Markdown shown under the status: how to talk to the agent. */
  hint?: string;
  sections?: { heading: string; lines: string[] }[];
}

export interface Chat {
  /** The adapter applies the trust filter and sets `author.trusted`. */
  start(onMessage: (message: ChatMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;

  /**
   * Markdown in; the adapter converts to the platform format and splits long text at line breaks. `<@id>` with a
   * member's id (`ChatMessage.author.id`) mentions that member.
   */
  post(
    channel: string,
    markdown: string,
    opts?: { thread?: string },
  ): Promise<{ id: string; thread: string }>;
  react(channel: string, messageId: string, name: "eyes" | "done" | "error"): Promise<void>;

  /** Capability `chat.history`. */
  history(channel: string, opts: { thread?: string; limit: number }): Promise<ChatMessage[]>;

  /**
   * Capability `chat.files`. The bytes of a file shared in a message, fetched with the adapter's own credentials.
   * Refuses a file that did not come from this chat (`invalid`).
   */
  download?(file: ChatFile): Promise<Uint8Array>;

  /**
   * Capability `chat.catchUp`. The requests written to the agent while it was not listening: after each cursor in
   * its conversation, and since `since` in the direct messages with the team's humans that have none. The same
   * filter as `start` applies (trusted humans, direct messages and mentions). A conversation the adapter cannot read
   * is left out, never thrown for.
   */
  missedSince?(opts: ChatMissedOptions): Promise<ChatMissed[]>;

  /** Channel id of a direct message with the user. */
  openDirect(userId: string): Promise<string>;

  /**
   * Capability `chat.agentProfile`. Shows the agent's profile and status in chat; adapters map it to their
   * platform's equivalent (for example Slack's Home tab).
   */
  setAgentProfile?(userId: string, profile: AgentProfile): Promise<void>;

  /**
   * Capability `chat.agentProfile`. Gives the adapter a way to get a fresh profile for a user when they open the
   * agent's profile page and the one it holds is older than a minute. `undefined` keeps the held profile.
   */
  onProfileRequest?(source: (userId: string) => Promise<AgentProfile | undefined>): void;
}

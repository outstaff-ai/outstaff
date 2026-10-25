export interface ChatMessage {
  id: string;
  channel: string;
  thread?: string;
  author: { id: string; name?: string; trusted: boolean; bot: boolean };
  text: string;
  at: string;

  /** The conversation is a direct message (a private chat). Adapters set it; absent means a channel. */
  direct?: boolean;
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

/** Split text into chunks of at most `max` characters, breaking at line breaks where possible. */
export function splitAtLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
    }

    current = "";
  };

  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }

      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > max) {
      flush();
      current = line;
    } else {
      current = next;
    }
  }

  flush();
  return chunks.length ? chunks : [""];
}

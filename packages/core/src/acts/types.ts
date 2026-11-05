import type { Chat } from "#/ports/chat.js";
import type { Knowledge } from "#/ports/knowledge.js";
import type { CanonicalStatus } from "#/ports/types.js";
import type { PullRequestToLink, Tracker } from "#/ports/tracker.js";

/** Who an act assigns a ticket to: an agent by handle, a human by the tracker identity the team file gives. */
export type ActTarget = { kind: "agent" | "human"; id: string };

/**
 * A tracker or knowledge-base change, or a direct message in chat, made with the acting agent's own identity.
 * `chat_dm` sends `body` (Markdown) to the chat member `to` (their `identities.chat`) in a direct message;
 * `chat_reply` posts it as a reply in the thread `thread` of the chat channel `channel`.
 */
export type ActOp =
  | { op: "move"; ticket: string; to: CanonicalStatus }
  | { op: "assign"; ticket: string; to: ActTarget | null }
  | { op: "comment"; on: { ticket: string } | { doc: string }; body: string }
  | { op: "set_parent"; ticket: string; parent: string }
  | { op: "link_pr"; ticket: string; pr: PullRequestToLink }
  | { op: "link_doc"; ticket: string; doc: string }
  | { op: "set_field"; ticket: string; field: string; value: number | null }
  | { op: "chat_dm"; to: string; body: string }
  | { op: "chat_reply"; channel: string; thread: string; body: string };

/** What applying an act did: one line per change made, and the error that stopped it, if any. */
export interface ActOutcome {
  ok: boolean;
  results: string[];
  error?: string | undefined;
}

export interface ActPorts {
  tracker?: Tracker | undefined;
  knowledge?: Knowledge | undefined;
  chat?: Pick<Chat, "openDirect" | "post"> | undefined;
}

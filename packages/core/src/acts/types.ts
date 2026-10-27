import type { Knowledge } from "#/ports/knowledge.js";
import type { CanonicalStatus } from "#/ports/types.js";
import type { Tracker } from "#/ports/tracker.js";

/** Who an act assigns a ticket to: an agent by handle, a human by the tracker identity the team file gives. */
export type ActTarget = { kind: "agent" | "human"; id: string };

/** A tracker or knowledge-base change, made with the acting agent's own identity. */
export type ActOp =
  | { op: "move"; ticket: string; to: CanonicalStatus }
  | { op: "assign"; ticket: string; to: ActTarget | null }
  | { op: "comment"; on: { ticket: string } | { doc: string }; body: string }
  | { op: "set_parent"; ticket: string; parent: string };

/** What applying an act did: one line per change made, and the error that stopped it, if any. */
export interface ActOutcome {
  ok: boolean;
  results: string[];
  error?: string | undefined;
}

export interface ActPorts {
  tracker?: Tracker | undefined;
  knowledge?: Knowledge | undefined;
}

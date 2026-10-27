import type { RunRequest } from "@outstaff/core";
import type { Offer } from "../office-client/index.js";
import type { ItemEnv } from "./loop.types.js";

/** How a round of the runtime ended. */
export interface Outcome {
  ok: boolean;
  text: string;
  error?: string | undefined;
  interrupted?: boolean | undefined;
  sessionLost?: boolean | undefined;
}

/** What an item is handed back as, once its run finished. */
export type HandBackStatus = "waiting" | "blocked" | "done";

/** One accepted item while it runs: what it was set up with, and what its rounds left behind. */
export interface ItemRun {
  offer: Offer;
  abort: AbortController;

  /** The session stored with the item, when an earlier round started one. */
  storedSession: string | undefined;

  /** The chat thread so far, for a new session of an item that came from chat. */
  chatContext: string | undefined;
  item: ItemEnv;

  /** The run request for a prompt, resuming the session given. */
  request(prompt: string, resume: string | undefined): RunRequest;

  /** The work prompt, for the first session or for one restarted from the journal. */
  prompt(restarted: boolean, context: string | undefined): string;

  /** The session the runtime is on now. */
  current: string | undefined;

  /** The runtime's latest message. */
  lastText: string;
}

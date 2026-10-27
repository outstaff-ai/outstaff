import type { ClonedRepo, Workspace } from "../repos/index.js";
import type { Attachment } from "./types.js";

/** What the runner knows of a run besides the offer, for its user prompt. */
export interface WorkPromptOptions {
  resumed: boolean;
  restarted?: boolean;
  interrupted?: boolean;
  workspace?: Workspace;

  /** The repositories the person has a grant on, with their access. */
  repos?: ClonedRepo[];
  chatContext?: string;

  /** The directory the catalog documents (`process/`, `references/`) are written to; their paths are absolute below it. */
  docsDir?: string;

  /** Files from the chat message that started the item, downloaded to scratch or listed. */
  attachments?: Attachment[];

  /** Files attached to the tickets the item concerns, by ticket key. */
  ticketFiles?: Record<string, Attachment[]>;
}

/** The path of a catalog document as the prompt names it. */
export type DocPath = (path: string) => string;

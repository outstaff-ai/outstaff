import type { Knowledge } from "../ports/knowledge.js";

/**
 * Where the text goes. "chat" and "tracker" surfaces do not link by themselves, so bare keys are linked. On the
 * "host" (code host) GitHub links keys through the repository's autolinks, so only wrong links are rewritten.
 */
export type TicketSurface = "chat" | "tracker" | "host";

export interface TicketLinker {
  /** `text` with the team's ticket keys linked to the tracker. Text is returned as is when there is nothing to link. */
  format(text: string, surface: TicketSurface): string;
}

export interface TicketLinkerOptions {
  /** The knowledge base; its host (and doc links) count as known when guarding URLs. */
  knowledge?: Pick<Knowledge, "links"> | undefined;

  /** Called with a description of a link on the tracker's or knowledge host that matches no known template and could not be replaced. */
  flag?: ((message: string) => void) | undefined;
}

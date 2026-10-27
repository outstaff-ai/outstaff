import type { Knowledge } from "../ports/knowledge.js";
import type { Tracker } from "../ports/tracker.js";

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

/** What a ticket linker knows: the tracker, the key pattern, the hosts it guards and their link templates. */
export interface TicketLinking {
  tracker: Pick<Tracker, "links">;

  /** Pattern source of a ticket key of the team's projects, such as `(?:ACME)-\d+`. */
  key: string;

  /** A whole string that is a ticket key, in any case. */
  exactKey: RegExp;

  /** Hosts of the tracker's and the knowledge base's links. */
  hosts: Set<string>;

  /** Links split around the id they carry. */
  docTemplate: LinkTemplate | undefined;
  issueTemplate: LinkTemplate | undefined;

  /** Whether the tracker's comment links carry an anchor of their own, so a fragment on an issue link can be real. */
  anchored: boolean;
  flag: ((message: string) => void) | undefined;
}

/** A URL split around the id a link template put in: `{prefix}<id>{suffix}`. */
export interface LinkTemplate {
  prefix: string;
  suffix: string;
}

import { PortError, type LinkRelation } from "@outstaff/core";
import { z } from "zod";
import { requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key } from "./ticket-support.js";

/** One link as the tracker states it: `from` blocks, relates to, `to`. */
interface Link {
  from: string;
  to: string;
  relation: LinkRelation;
}

/** The link the input names, stated the way the tracker takes it. */
function linkOf(input: {
  key: string;
  blockedBy?: string | undefined;
  blocks?: string | undefined;
  relates?: string | undefined;
}): Link {
  const named = [input.blockedBy, input.blocks, input.relates].filter((k) => k !== undefined);
  if (named.length !== 1) {
    throw new PortError("invalid", "Pass exactly one of blocked-by, blocks or relates.");
  }

  const other = named[0]!;
  if (other.toLowerCase() === input.key.toLowerCase()) {
    throw new PortError("invalid", `${input.key} cannot be linked to itself.`);
  }

  if (input.blockedBy !== undefined) {
    return { from: other, to: input.key, relation: "blocks" };
  }

  return {
    from: input.key,
    to: other,
    relation: input.blocks === undefined ? "relates" : "blocks",
  };
}

const said = ({ from, to, relation }: Link) =>
  relation === "blocks" ? `${from} blocks ${to}` : `${from} relates to ${to}`;

export const ticketLink = defineVerb({
  name: "ticket.link",
  summary: "Link a ticket to another: blocked by it, blocking it, or related; or remove the link.",
  description:
    "Links two tickets in the tracker, where the tracker shows the link and the office reads it. A dependency is a link, never text in a description: pass blocked-by with the ticket that must be done first, blocks for the other way round, or relates for a ticket that is only related. A ticket in the blocked status whose last open blocker closes moves to ready, and its agent is woken. Linking changes no status: a ticket that cannot start before its blocker closes goes to blocked (ost ticket move <ticket> blocked). Pass remove to delete the link instead; removing a link that does not exist changes nothing. The parent of a sub-ticket is not a link: use ost ticket parent.",
  input: z.strictObject({
    key,
    blockedBy: key.optional().describe("Key of the ticket that blocks this one."),
    blocks: key.optional().describe("Key of the ticket this one blocks."),
    relates: key.optional().describe("Key of a ticket this one only relates to."),
    remove: z.boolean().default(false).describe("Remove the link instead of adding it."),
  }),
  args: ["key"],
  examples: [
    "ost ticket link ACME-51 --blocked-by ACME-50",
    "ost ticket link ACME-51 --relates ACME-48",
    "ost ticket link ACME-51 --blocked-by ACME-50 --remove",
  ],
  async run(env, input) {
    const tracker = requireTracker(env);
    const link = linkOf(input);
    if (input.remove) {
      await tracker.unlink(link.from, link.to, link.relation);
    } else {
      await tracker.link(link.from, link.to, link.relation);
    }

    const url = tracker.links.issue(input.key);
    const line = input.remove ? `Removed the link: ${said(link)}.` : `Linked: ${said(link)}.`;

    return result([line, url], { ...link, removed: input.remove }, [url]);
  },
});

import { silentLogger } from "@outstaff/core";
import type { WorkItem } from "../store/types.js";
import type { MirrorOptions, MirrorWhere } from "./types.js";

/**
 * Makes a question or an answer visible to humans: the team channel when one is configured, else the ticket of the
 * asker's item, else only the item journal (which the caller writes). A failing channel or tracker falls through
 * to the next option, so nothing is invisible.
 */
export async function mirror(
  opts: MirrorOptions,
  asker: WorkItem,
  text: string,
): Promise<MirrorWhere> {
  const log = opts.logger ?? silentLogger;
  let where: MirrorWhere = "journal";
  if (opts.chat && opts.channel) {
    try {
      await opts.chat.post(opts.channel, text);
      where = "channel";
    } catch (err) {
      log.warn("could not mirror to the team channel", { error: String(err) });
    }
  }

  if (where === "journal" && opts.tracker && asker.subject?.type === "ticket") {
    try {
      await opts.tracker.comment(asker.subject.ref, text);
      where = "ticket";
    } catch (err) {
      log.warn("could not mirror to the ticket", { ticket: asker.subject.ref, error: String(err) });
    }
  }

  return where;
}

import { silentLogger, type Logger } from "@outstaff/core";
import type { WorkItem } from "../store/types.js";
import type { MirrorOptions, MirrorWhere } from "./types.js";

/** Posts to the team channel, if there is one; false when there is none or the post failed. */
async function toChannel(opts: MirrorOptions, text: string, log: Logger): Promise<boolean> {
  if (!opts.chat || !opts.channel) {
    return false;
  }

  try {
    await opts.chat.post(opts.channel, text);
    return true;
  } catch (err) {
    log.warn("could not mirror to the team channel", { error: String(err) });
    return false;
  }
}

/** Comments on the ticket the asker works on, if there is a tracker; false when it cannot. */
async function toTicket(
  opts: MirrorOptions,
  asker: WorkItem,
  text: string,
  log: Logger,
): Promise<boolean> {
  if (!opts.tracker || asker.subject?.type !== "ticket") {
    return false;
  }

  try {
    await opts.tracker.comment(asker.subject.ref, text);
    return true;
  } catch (err) {
    log.warn("could not mirror to the ticket", { ticket: asker.subject.ref, error: String(err) });
    return false;
  }
}

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
  if (await toChannel(opts, text, log)) {
    return "channel";
  }

  return (await toTicket(opts, asker, text, log)) ? "ticket" : "journal";
}

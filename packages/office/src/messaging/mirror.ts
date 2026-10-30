import { silentLogger, type Logger } from "@outstaff/core";
import type { WorkItem } from "#/store/types.js";
import type { Mirrored, MirrorOptions, MirrorWhere } from "./types.js";

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

/**
 * Has the asker's agent comment on the ticket it works on, as itself: queued for it, and made when it is connected.
 * False when there is no ticket or the comment cannot be queued.
 */
async function toTicket(
  opts: MirrorOptions,
  asker: WorkItem,
  m: Mirrored,
  log: Logger,
): Promise<boolean> {
  if (!opts.acts || asker.subject?.type !== "ticket") {
    return false;
  }

  const ticket = asker.subject.ref;
  try {
    await opts.acts.send(asker.person, {
      id: m.id,
      ops: [{ op: "comment", on: { ticket }, body: m.text }],
    });

    return true;
  } catch (err) {
    log.warn("could not mirror to the ticket", { ticket, error: String(err) });
    return false;
  }
}

/**
 * Makes a question or an answer visible to humans: the team channel when one is configured, else a comment the
 * asker's agent posts on the ticket of its item, else only the item journal (which the caller writes). A failing
 * channel or queue falls through to the next option, so nothing is invisible. The office never writes to the tracker.
 */
export async function mirror(
  opts: MirrorOptions,
  asker: WorkItem,
  m: Mirrored,
): Promise<MirrorWhere> {
  const log = opts.logger ?? silentLogger;
  if (await toChannel(opts, m.text, log)) {
    return "channel";
  }

  return (await toTicket(opts, asker, m, log)) ? "ticket" : "journal";
}

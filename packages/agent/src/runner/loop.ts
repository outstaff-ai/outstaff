import { policyOn, silentLogger } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import { acknowledgeFeedback } from "./reactions.js";
import { createSessionManager } from "./sessions.js";
import type { WorkLoopOptions, WorkLoop } from "./loop.types.js";
import { reason } from "./reason.js";
import { CHAT_KIND, createWorker } from "./work.js";

export function createWorkLoop(opts: WorkLoopOptions): WorkLoop {
  const log = opts.log ?? silentLogger;
  const sessions = opts.sessions ?? createSessionManager(opts.office, log);
  const work = createWorker({ opts, log, sessions });
  let stopping = false;
  const running = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  let workLane: Promise<void> = Promise.resolve();

  /** Items the office still lists as ours after a restart have no offer to resume from; it queues them again. */
  async function releaseResumed() {
    for (const id of opts.office.resume()) {
      try {
        await opts.office.decline(id, "The agent restarted while working on this item.");
      } catch (e) {
        log.warn("could not release an item left over from before a restart", {
          workItemId: id,
          error: reason(e),
        });
      }
    }
  }

  /** Takes the offer; an offer the office would not give us is dropped. */
  async function accepted(id: string): Promise<boolean> {
    try {
      await opts.office.accept(id);

      return true;
    } catch (e) {
      log.warn("could not accept an offer", { workItemId: id, error: reason(e) });

      return false;
    }
  }

  /** Runs an accepted item to its hand-back; a failure is reported to the office. */
  async function runAccepted(offer: Offer, abort: AbortController) {
    const id = offer.workItem.id;
    opts.profile?.changed();
    opts.usage?.setBusy(true);
    try {
      // Before the run starts, so the people who wrote the feedback see at once that it was taken.
      if (policyOn(opts.policies, "acknowledge.vcs")) {
        await acknowledgeFeedback(offer, opts.env.vcs, log);
      }

      await work(offer, abort);
    } catch (e) {
      log.error("work item failed", { workItemId: id, error: reason(e) });
      await opts.office.fail(id, reason(e)).catch(() => {});
    } finally {
      running.delete(id);
      opts.usage?.setBusy(running.size > 0);
      opts.usage?.flush();
      // Handed back or failed: the status is idle now, or the next item.
      opts.profile?.changed();
    }
  }

  async function handle(offer: Offer) {
    const id = offer.workItem.id;
    const abort = new AbortController();
    running.set(id, abort);
    if (!(await accepted(id))) {
      running.delete(id);

      return;
    }

    if (stopping) {
      abort.abort();
    }

    await runAccepted(offer, abort);
  }

  const track = (p: Promise<void>) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  return {
    async run() {
      await releaseResumed();
      for await (const offer of opts.office.offers()) {
        if (stopping) {
          // Not accepted, so the office offers it again later.
          break;
        }

        opts.profile?.changed();
        if (offer.workItem.kind === CHAT_KIND && opts.chatSession) {
          track(handle(offer));
        } else {
          // One work item at a time, in the order they came.
          workLane = workLane.then(() => (stopping ? undefined : handle(offer)));
          track(workLane);
        }
      }

      await Promise.all(inFlight);
    },

    async stop() {
      stopping = true;
      for (const abort of running.values()) {
        abort.abort();
      }

      await Promise.all(inFlight);
    },
  };
}

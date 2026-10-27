import type { RunRequest, RuntimeEvent } from "@outstaff/core";
import type { WorkerContext } from "./loop.types.js";
import { reason } from "./reason.js";
import type { ItemRun, Outcome } from "./work.types.js";

const PROGRESS_MAX = 300;

const progressLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > PROGRESS_MAX ? `${line.slice(0, PROGRESS_MAX - 1)}…` : line;
};

/**
 * Runs rounds of the runtime for one item: it stores the session the runtime starts, keeps the latest message, sends
 * progress at most every `progressEveryMs` and forwards usage. A round resolves to how it ended.
 */
export function createRounds({ opts, log, sessions }: WorkerContext, run: ItemRun) {
  const id = run.offer.workItem.id;
  const now = opts.now ?? Date.now;
  const progressEveryMs = opts.progressEveryMs ?? 30_000;
  let lastProgress = Number.NEGATIVE_INFINITY;

  function progress(text: string) {
    const t = now();
    const line = progressLine(text);
    if (!line || t - lastProgress < progressEveryMs) {
      return;
    }

    lastProgress = t;
    opts.office.progress(id, line).catch((err) => {
      log.warn("could not send progress", { workItemId: id, error: reason(err) });
    });
  }

  /** Follows one event of the run; the `finished` event is how the round ended. */
  async function follow(e: RuntimeEvent): Promise<Outcome | undefined> {
    switch (e.type) {
      case "started":
        run.current = e.sessionId;
        await sessions.started(id, e.sessionId);
        return undefined;
      case "text":
        run.lastText = e.text;
        progress(e.text);
        return undefined;
      case "usage":
        opts.usage?.observe(e);
        return undefined;
      case "finished":
        return e;
      default:
        return undefined;
    }
  }

  return async function round(request: RunRequest): Promise<Outcome | undefined> {
    let outcome: Outcome | undefined;
    try {
      for await (const e of opts.runtime.run(request)) {
        outcome = (await follow(e)) ?? outcome;
      }
    } catch (e) {
      outcome = { ok: false, text: run.lastText, error: reason(e) };
    }

    return outcome;
  };
}

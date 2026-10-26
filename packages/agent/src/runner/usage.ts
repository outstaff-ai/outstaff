import { silentLogger, type UsageEvent } from "@outstaff/core";
import { systemClientClock, type ClientClock } from "../office-client/index.js";
import type { UsageThresholds, UsageReporterOptions, UsageReporter } from "./types.js";

const DEFAULT_THRESHOLDS: UsageThresholds = { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 };

const clockNow = (c: ClientClock) => c.now().getTime();

export function createUsageReporter(opts: UsageReporterOptions): UsageReporter {
  const log = opts.log ?? silentLogger;
  const clock = opts.clock ?? systemClientClock;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const minIntervalMs = opts.minIntervalMs ?? 60_000;
  const probeEveryMs = opts.probeEveryMs ?? 600_000;

  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastBand = 0;
  let held: UsageEvent["windows"] | undefined;
  let busy = false;
  let running = false;
  let cancel: (() => void) | undefined;

  /** 0 below the defer threshold, 1 from it, 2 from the pause threshold. */
  const bandOf = (windows: UsageEvent["windows"]) => {
    const peak = Math.max(0, ...windows.map((w) => w.utilization));
    return peak >= thresholds.pause_automatic_at
      ? 2
      : peak >= thresholds.defer_scheduled_at
        ? 1
        : 0;
  };

  function send(windows: UsageEvent["windows"]) {
    held = undefined;
    lastSentAt = clockNow(clock);
    lastBand = bandOf(windows);
    opts.send(windows).catch((e: unknown) => {
      log.warn("could not report usage", { error: e instanceof Error ? e.message : String(e) });
    });
  }

  function report(event: UsageEvent) {
    if (event.windows.length === 0) {
      return;
    }

    if (bandOf(event.windows) !== lastBand || clockNow(clock) - lastSentAt >= minIntervalMs) {
      send(event.windows);
    } else {
      held = event.windows;
    }
  }

  async function probe() {
    if (busy || !opts.runtime?.probeUsage) {
      return;
    }

    try {
      report(await opts.runtime.probeUsage());
    } catch (e) {
      log.warn("could not probe usage", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function schedule() {
    cancel = clock.setTimeout(() => {
      if (!running) {
        return;
      }

      void probe().finally(() => {
        if (running) {
          schedule();
        }
      });
    }, probeEveryMs);
  }

  return {
    observe: report,

    flush() {
      if (held) {
        send(held);
      }
    },

    setBusy(value) {
      busy = value;
    },

    start() {
      if (running) {
        return;
      }

      running = true;
      void probe().finally(() => {
        if (running) {
          schedule();
        }
      });
    },

    stop() {
      running = false;
      cancel?.();
    },
  };
}

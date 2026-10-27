import type { Clock, ManualClock } from "./types.js";

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export function manualClock(start = "2030-01-01T00:00:00.000Z"): ManualClock {
  let t = Date.parse(start);
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => new Date(t),
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn });
      return () => void timers.delete(id);
    },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
            next = entry;
          }
        }

        if (!next) {
          break;
        }

        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }

      t = target;
    },
    pending: () => timers.size,
  };
}

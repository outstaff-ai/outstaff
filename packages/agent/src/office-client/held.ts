/**
 * What the office hands over for a handler that may be set later (queued reports, acts): kept until the handler is
 * set, then given to it at once.
 */
export function heldFor<T>() {
  let handler: ((items: T[]) => void) | undefined;
  let held: T[] = [];

  return {
    deliver(items: T[]) {
      if (handler) {
        handler(items);
      } else {
        held.push(...items);
      }
    },

    listen(next: (items: T[]) => void) {
      handler = next;
      if (held.length) {
        const items = held;
        held = [];
        next(items);
      }
    },
  };
}

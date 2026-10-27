import type { Route, RoutablePerson } from "./types.js";

/**
 * Picks who answers. A handle matches exactly and wins over a role of the same name. A role goes to the least busy
 * person with it (fewest queued and active items, ties by team order). Asking your own role means a peer, so the
 * asker is left out.
 */
export function routeQuestion(input: {
  from: string;
  to: string;
  people: readonly RoutablePerson[];

  /** Queued plus active items per handle. */
  load: ReadonlyMap<string, number>;
}): Route {
  const { from, to, people, load } = input;
  if (to === from) {
    return { ok: false, code: "invalid", message: "You cannot ask yourself." };
  }

  if (people.some((p) => p.handle === to)) {
    return { ok: true, handle: to };
  }

  const asker = people.find((p) => p.handle === from);
  const candidates = people.filter((p) => p.role === to && p.handle !== from);
  if (candidates.length === 0) {
    const peerless = asker?.role === to;
    return {
      ok: false,
      code: "not_found",
      message: peerless
        ? `no other ${to} on this team; ask a human`
        : `no ${to} on this team; ask a human`,
    };
  }

  let best = candidates[0]!;
  for (const c of candidates) {
    if ((load.get(c.handle) ?? 0) < (load.get(best.handle) ?? 0)) {
      best = c;
    }
  }

  return { ok: true, handle: best.handle };
}

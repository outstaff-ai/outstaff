import type { Route, RoutablePerson } from "./types.js";

/** Nobody has the role; `peerless` when only the asker has it. */
function noOne(to: string, peerless: boolean): Route {
  return {
    ok: false,
    code: "not_found",
    message: peerless
      ? `no other ${to} on this team; ask a human`
      : `no ${to} on this team; ask a human`,
  };
}

/** The first of the people with the fewest queued and active items. */
function leastBusy(people: readonly RoutablePerson[], load: ReadonlyMap<string, number>) {
  const loadOf = (p: RoutablePerson) => load.get(p.handle) ?? 0;
  return people.reduce((best, p) => (loadOf(p) < loadOf(best) ? p : best));
}

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

  const candidates = people.filter((p) => p.role === to && p.handle !== from);
  if (candidates.length === 0) {
    return noOne(to, people.find((p) => p.handle === from)?.role === to);
  }

  return { ok: true, handle: leastBusy(candidates, load).handle };
}

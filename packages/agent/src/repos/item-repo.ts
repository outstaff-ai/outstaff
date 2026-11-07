import { parseRepoUrl } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import type { ClonedRepo, UnpreparedRepo } from "./types.js";

/** The repo of `repos` a subject or link of the item names. */
function namedRepo<R extends Pick<ClonedRepo, "ref">>(offer: Offer, repos: R[]): R | undefined {
  const urls = [
    ...offer.context.subjects.map((s) => s.url),
    ...offer.context.links.map((l) => l.url),
  ];

  for (const url of urls) {
    if (!url) {
      continue;
    }

    try {
      const ref = parseRepoUrl(url.replace(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+).*$/, "$1"));
      const hit = repos.find(
        (r) =>
          r.ref.host === ref.host &&
          r.ref.owner.toLowerCase() === ref.owner.toLowerCase() &&
          r.ref.name.toLowerCase() === ref.name.toLowerCase(),
      );

      if (hit) {
        return hit;
      }
    } catch {
      // Not a repository URL.
    }
  }

  return undefined;
}

/** The repo an item is about: one named by a subject or link, else the primary repo or the first one that can be written. */
export function repoForItem(offer: Offer, repos: ClonedRepo[]): ClonedRepo | undefined {
  const writable = repos.filter((r) => r.access === "write");
  return namedRepo(offer, repos) ?? writable.find((r) => r.kind === "primary") ?? writable[0];
}

/**
 * The unprepared repositories an item may need: the one it names, else, when it names no prepared one either, the
 * writable ones, since the repo it falls back to may be among them.
 */
export function neededBy(offer: Offer, repos: ClonedRepo[], unprepared: UnpreparedRepo[]) {
  const named = namedRepo(offer, unprepared);
  if (named) {
    return [named];
  }

  return namedRepo(offer, repos) ? [] : unprepared.filter((u) => u.access === "write");
}

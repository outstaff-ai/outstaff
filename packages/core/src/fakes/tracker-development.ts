import type { PullRequestToLink, RepoRef } from "#/ports/index.js";
import type { FakeTracker } from "./types.js";

const fullName = (repo: Pick<RepoRef, "owner" | "name">) =>
  `${repo.owner}/${repo.name}`.toLowerCase();

/**
 * The fake's "Development" section: the repositories connected to it (`connected`, which the seed adds to) and the
 * pull requests linked on each ticket, with who linked them. Any pull request of a connected repository can be linked.
 */
export function fakeDevelopment(need: (key: string) => unknown, actor: () => string) {
  const connected: RepoRef[] = [];
  const development: FakeTracker["development"] = new Map();

  return {
    connected,
    development,

    async linkPullRequest(key: string, pr: PullRequestToLink) {
      need(key);
      if (!connected.some((r) => fullName(r) === fullName(pr.repo))) {
        return "not_connected" as const;
      }

      const list = development.get(key) ?? [];
      if (list.some((l) => fullName(l.repo) === fullName(pr.repo) && l.number === pr.number)) {
        return "already_linked" as const;
      }

      development.set(key, [...list, { ...structuredClone(pr), by: actor() }]);
      return "linked" as const;
    },

    async connectedRepositories() {
      return structuredClone(connected);
    },
  };
}

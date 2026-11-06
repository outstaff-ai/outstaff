import { PortError } from "#/ports/index.js";
import type { FakeHistory } from "./vcs.types.js";

/**
 * The commits of a fake vcs's branches: each commit knows its parents, so `contains` walks real ancestry. A branch is
 * there once a commit or a merge lands on it.
 */
export function createHistory(newSha: () => string): FakeHistory {
  const heads = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const at = (repo: string, branch: string) => `${repo}@${branch}`;

  const land = (repo: string, branch: string, of: string[]) => {
    const sha = newSha();
    parents.set(sha, of);
    heads.set(at(repo, branch), sha);
    return sha;
  };

  const before = (repo: string, branch: string, from?: string) => {
    const head = from ?? heads.get(at(repo, branch));
    return head ? [head] : [];
  };

  return {
    commit: (repo, branch, from) => land(repo, branch, before(repo, branch, from)),
    merge: (repo, branch, head) => land(repo, branch, [...before(repo, branch), head]),
    head(repo, branch) {
      const sha = heads.get(at(repo, branch));
      if (!sha) {
        throw new PortError("not_found", `No branch ${branch} in ${repo}.`);
      }

      return sha;
    },
    contains(sha, ancestor) {
      const seen = new Set<string>();
      const todo = [sha];
      for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
        if (next === ancestor) {
          return true;
        }

        if (!seen.has(next)) {
          seen.add(next);
          todo.push(...(parents.get(next) ?? []));
        }
      }

      return false;
    },
  };
}

import { PortError, type Vcs } from "@outstaff/core";
import type { RestBranch, RestCompare } from "#/api.types.js";
import { repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/** A head that is the base or has it in its history. */
const CONTAINS = new Set<RestCompare["status"]>(["identical", "ahead"]);

/** A branch's head commit and whether a commit contains another, with the office's credentials. */
export function historyOperations(c: GithubContext): Pick<Vcs, "branchHead" | "contains"> {
  const { http, apiToken } = c;
  return {
    async branchHead(repo, branch) {
      const path = `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`;
      const { data } = await http.request<RestBranch>("GET", path, {
        token: await apiToken(repo),
      });

      if (!data.commit?.sha) {
        throw new PortError("not_found", `GitHub reported no commit for ${branch}.`);
      }

      return data.commit.sha;
    },

    async contains(repo, sha, ancestor) {
      const path = `${repoPath(repo)}/compare/${ancestor}...${sha}`;
      const { data } = await http.request<RestCompare>("GET", path, {
        token: await apiToken(repo),
        query: { per_page: 1 },
      });

      return CONTAINS.has(data.status);
    },
  };
}

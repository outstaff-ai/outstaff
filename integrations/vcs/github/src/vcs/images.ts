import { PortError, imageFileName, type RepoRef, type Vcs } from "@outstaff/core";
import type { RestGitCommit, RestGitObject, RestGitRef } from "#/api.types.js";
import { PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

/** A path of segments, each escaped for a URL. */
const escaped = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Images for pull requests, committed with the git data API to the assets branch as this container's own App: the
 * first one makes the branch, an orphan with no parent, so nothing reaches the default branch or its history; later
 * ones add to its tree. GitHub serves a file of a branch as `blob/<branch>/<path>?raw=true` with the viewer's own
 * access, so the link renders in a private repository too, where an image hosted elsewhere goes through GitHub's
 * image proxy and breaks.
 */
export function imageOperations(c: GithubContext): Pick<Vcs, "storeImage"> {
  const { http, web, assetsBranch, actingToken } = c;
  const branchPath = (repo: RepoRef) => `${repoPath(repo)}/git/ref/heads/${escaped(assetsBranch)}`;

  /** The branch's head commit, or undefined while the branch does not exist. */
  async function headOf(repo: RepoRef, token: string): Promise<string | undefined> {
    try {
      return (await http.request<RestGitRef>("GET", branchPath(repo), { token })).data.object.sha;
    } catch (e) {
      if (e instanceof PortError && e.code === "not_found") {
        return undefined;
      }

      throw e;
    }
  }

  const post = async <T>(repo: RepoRef, what: string, token: string, body: unknown) =>
    (await http.request<T>("POST", `${repoPath(repo)}/git/${what}`, { token, body })).data;

  /** The tree of the new commit: the head's tree with the file added or replaced, or the file alone. */
  async function treeWith(
    repo: RepoRef,
    token: string,
    head: string | undefined,
    file: string,
    blob: string,
  ) {
    const base = head
      ? (
          await http.request<RestGitCommit>("GET", `${repoPath(repo)}/git/commits/${head}`, {
            token,
          })
        ).data.tree.sha
      : undefined;

    const tree = await post<RestGitObject>(repo, "trees", token, {
      ...(base ? { base_tree: base } : {}),
      tree: [{ path: file, mode: "100644", type: "blob", sha: blob }],
    });

    return tree.sha;
  }

  /** Points the branch at the commit: a new branch, or a fast-forward of the old head. */
  async function moveBranch(repo: RepoRef, token: string, head: string | undefined, sha: string) {
    if (head) {
      const path = `${repoPath(repo)}/git/refs/heads/${escaped(assetsBranch)}`;
      await http.request("PATCH", path, { token, body: { sha, force: false } });
    } else {
      await post(repo, "refs", token, { ref: `refs/heads/${assetsBranch}`, sha });
    }
  }

  return {
    async storeImage(repo, number, image) {
      const name = imageFileName(image);
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      // An unknown pull request is not_found before anything is written.
      await http.request("GET", `${repoPath(repo)}/pulls/${number}`, { token });
      const path = `${number}/${name}`;
      const head = await headOf(repo, token);
      const blob = await post<RestGitObject>(repo, "blobs", token, {
        content: Buffer.from(image.data).toString("base64"),
        encoding: "base64",
      });

      const tree = await treeWith(repo, token, head, path, blob.sha);
      const commit = await post<RestGitCommit>(repo, "commits", token, {
        message: `Image ${name} for pull request #${number}`,
        tree,
        parents: head ? [head] : [],
      });

      await moveBranch(repo, token, head, commit.sha);
      return {
        url: `${web}/${repo.owner}/${repo.name}/blob/${escaped(assetsBranch)}/${escaped(path)}?raw=true`,
        path,
      };
    },
  };
}

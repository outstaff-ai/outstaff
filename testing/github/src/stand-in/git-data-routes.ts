import { createHash } from "node:crypto";
import type { RestGitCommit, RestGitRef } from "@outstaff/integration.vcs.github";
import type { Route, StandInRequest } from "@outstaff/testing.http";
import { NOT_FOUND, UNAUTHORIZED } from "./model.js";
import type { GitData } from "./git-data.types.js";
import type { GithubAuth } from "./types.js";

const shaOf = (kind: string, text: string) =>
  createHash("sha1").update(`${kind}\0${text}`).digest("hex");

const invalid = (message: string) => ({ status: 422, body: { message } });

export const createGitData = (): GitData => ({
  blobs: new Map(),
  trees: new Map(),
  commits: new Map(),
  refs: new Map(),
});

const refOf = (branch: string, sha: string): RestGitRef => ({
  ref: `refs/heads/${branch}`,
  object: { sha },
});

const commitOf = (g: GitData, sha: string): RestGitCommit | undefined => {
  const c = g.commits.get(sha);
  return c && { sha, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) };
};

interface NewTree {
  base_tree?: string;
  tree: { path: string; sha: string }[];
}

function makeTree(g: GitData, b: NewTree) {
  const base = b.base_tree === undefined ? new Map<string, string>() : g.trees.get(b.base_tree);
  if (!base || b.tree.some((e) => !g.blobs.has(e.sha))) {
    return invalid("A tree or blob of the request does not exist.");
  }

  const files = new Map([...base, ...b.tree.map((e) => [e.path, e.sha] as const)]);
  const sha = shaOf("tree", JSON.stringify([...files].sort()));
  g.trees.set(sha, files);
  return { status: 201, body: { sha } };
}

function makeCommit(g: GitData, b: { message: string; tree: string; parents: string[] }) {
  if (!g.trees.has(b.tree) || b.parents.some((p) => !g.commits.has(p))) {
    return invalid("The tree or a parent of the commit does not exist.");
  }

  const sha = shaOf("commit", JSON.stringify([b.tree, b.parents, b.message, g.commits.size]));
  g.commits.set(sha, { tree: b.tree, parents: b.parents, message: b.message });
  return { status: 201, body: commitOf(g, sha) };
}

/** Moves a branch: only to a commit on top of its head, unless forced. */
function moveRef(g: GitData, branch: string, b: { sha: string; force?: boolean }) {
  const head = g.refs.get(branch);
  if (!head) {
    return invalid("Reference does not exist");
  }

  if (!b.force && !g.commits.get(b.sha)?.parents.includes(head)) {
    return invalid("Update is not a fast forward");
  }

  g.refs.set(branch, b.sha);
  return refOf(branch, b.sha);
}

/** The files of each branch made with the git data API, as the end-to-end driver reads them. */
export function gitDataState(g: GitData) {
  return Object.fromEntries(
    [...g.refs].map(([branch, sha]) => [
      branch,
      [...g.trees.get(g.commits.get(sha)!.tree)!].map(([path, blob]) => ({
        path,
        base64: g.blobs.get(blob)!,
      })),
    ]),
  );
}

/** The content of a file on a branch made with the git data API, base64; undefined when there is none. */
export function gitDataFile(g: GitData, branch: string, path: string): string | undefined {
  const head = g.refs.get(branch);
  const blob = head && g.trees.get(g.commits.get(head)!.tree)!.get(path);
  return blob ? g.blobs.get(blob) : undefined;
}

/** The branch a (decoded) path names after `marker`, which may have slashes. */
const branchIn = (r: StandInRequest, marker: string) =>
  r.path.slice(r.path.indexOf(marker) + marker.length);

/** The git data API: blobs, trees, commits and branch refs, written by an installation token. */
export function gitDataRoutes(g: GitData, auth: GithubAuth, repo: string): Route[] {
  const git = `${repo}/git`;
  const write =
    (handler: (r: StandInRequest) => unknown): Route["handler"] =>
    (r) =>
      auth.actorOf(r) ? handler(r) : UNAUTHORIZED;

  return [
    {
      method: "GET",
      path: `${git}/ref/heads/*`,
      handler: (r) => {
        const branch = branchIn(r, "/git/ref/heads/");
        const sha = g.refs.get(branch);
        return sha ? refOf(branch, sha) : NOT_FOUND;
      },
    },
    {
      method: "GET",
      path: `${git}/commits/:sha`,
      handler: (r) => commitOf(g, r.params["sha"]!) ?? NOT_FOUND,
    },
    {
      method: "POST",
      path: `${git}/blobs`,
      handler: write((r) => {
        const content = String(r.json.content);
        const sha = shaOf("blob", content);
        g.blobs.set(sha, content);
        return { status: 201, body: { sha } };
      }),
    },
    { method: "POST", path: `${git}/trees`, handler: write((r) => makeTree(g, r.json)) },
    { method: "POST", path: `${git}/commits`, handler: write((r) => makeCommit(g, r.json)) },
    {
      method: "POST",
      path: `${git}/refs`,
      handler: write((r) => {
        const branch = String(r.json.ref).replace(/^refs\/heads\//, "");
        if (g.refs.has(branch)) {
          return invalid("Reference already exists");
        }

        if (!g.commits.has(r.json.sha)) {
          return invalid("Object does not exist");
        }

        g.refs.set(branch, r.json.sha);
        return { status: 201, body: refOf(branch, r.json.sha) };
      }),
    },
    {
      method: "PATCH",
      path: `${git}/refs/heads/*`,
      handler: write((r) => moveRef(g, branchIn(r, "/git/refs/heads/"), r.json)),
    },
  ];
}

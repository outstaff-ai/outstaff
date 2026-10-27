import { appAuth } from "./app-auth.js";
import { REVIEW_STATE, addComment, submitReview } from "./conversation.js";
import { e2eState } from "./e2e-state.js";
import type { DriverComment, GithubE2eOptions } from "./e2e.types.js";
import { gitServer } from "./git-serve.js";
import { headSha, mergePull, pullOf } from "./model.js";
import { createGithubStandIn } from "./stand-in.js";
import type { GithubStore, StoredPull } from "./types.js";

/** Real time, strictly increasing, so that two things written one after the other are told apart by time alone. */
function realClock(): () => string {
  let last = 0;
  return () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
}

const needPull = (s: GithubStore, n: number): StoredPull => {
  const pr = pullOf(s, n);
  if (!pr) {
    throw new Error(`No pull request ${n}.`);
  }

  return pr;
};

/** What the test driver does on GitHub as the humans of the team. */
function controls(s: GithubStore) {
  const full = `${s.repo.owner}/${s.repo.name}`;
  return {
    async review(
      n: number,
      actor: string,
      event: string,
      body: string,
      comments?: DriverComment[],
    ) {
      const state = REVIEW_STATE[event] ?? event;
      await submitReview(s, needPull(s, n), actor, state, body, comments ?? []);
    },

    /** A human comments on the pull request conversation. */
    async comment(n: number, actor: string, body: string) {
      addComment(s, needPull(s, n), actor, body, true);
    },

    /** A completed check run on the pull request's head commit, as a CI service would report it. */
    async setCheck(n: number, name: string, conclusion: string) {
      const pr = pullOf(s, n);
      const sha = pr && (await headSha(s, pr));
      if (!sha) {
        throw new Error(`Pull request ${n} has no head commit.`);
      }

      const run = {
        id: ++s.counters.checkId,
        name,
        status: "completed",
        conclusion,
        html_url: `https://github.acme.example/${full}/runs/${name}`,
        output: { title: `${name} ${conclusion}`, summary: `${name} ${conclusion}` },
      };

      s.checks.set(sha, [...(s.checks.get(sha) ?? []).filter((c) => c.name !== name), run]);
    },

    async merge(n: number, actor: string) {
      const pr = pullOf(s, n);
      if (!pr || pr.state !== "open") {
        throw new Error(`Pull request ${n} is not open.`);
      }

      await mergePull(s, pr, actor, `Merge pull request #${n}`);
    },
  };
}

/**
 * The stand-in as the end-to-end stubs serve it: GitHub Enterprise paths, real time, Apps that sign their JWTs,
 * a real repository (plus `more`, for git only) served over smart HTTP, a merge queue that merges 1.5 s after
 * `merge-async`, and the controls the test driver acts through.
 */
export function createGithubE2e(opts: GithubE2eOptions) {
  const auth = appAuth(opts);
  const { store, routes, dispatch } = createGithubStandIn({
    repo: { owner: opts.repo.owner, name: opts.repo.name },
    backend: opts.repo,
    now: realClock(),
    auth: () => auth,
    queueDelayMs: 1500,
    apiPrefix: "/api/v3",
    graphqlPath: "/api/graphql",
    more: opts.more ?? [],
    permissions: opts.permissions,
    mergeSettings: { queue: true, methods: ["merge", "squash"] },
  });

  const git = gitServer(store, auth, [opts.repo, ...(opts.more ?? [])]);
  return {
    routes,
    dispatch,
    isGitPath: git.isGitPath,
    serveGit: git.serveGit,
    ...controls(store),
    state: () => e2eState(store),
  };
}

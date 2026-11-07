import { createRouter } from "@outstaff/testing.http";
import { RUN_ID } from "./actions-routes.js";
import { appAuth } from "./app-auth.js";
import { REVIEW_STATE, addComment, submitReview } from "./conversation.js";
import { e2eState } from "./e2e-state.js";
import type { DriverCheck, DriverComment, GithubE2eOptions } from "./e2e.types.js";
import { extensionRoutes } from "./extension-routes.js";
import { gitServer } from "./git-serve.js";
import { closePull, headSha, mergePull, pullOf } from "./model.js";
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

/** The raw log of an Actions job: a set-up step, then the step that ran and its output, with GitHub's markers. */
const jobLog = (c: DriverCheck) =>
  [
    "##[group]Set up job",
    "Runner ready",
    "##[endgroup]",
    `##[group]${c.step ?? "Run"}`,
    "##[endgroup]",
    ...(c.log ?? []),
    ...(c.conclusion === "success" ? [] : ["##[error]Process completed with exit code 1."]),
  ]
    .map((line) => `${new Date().toISOString()} ${line}`)
    .join("\n");

/** A completed check run on a commit, backed by an Actions job with its log. */
function jobCheck(s: GithubStore, sha: string, c: DriverCheck) {
  const id = ++s.counters.checkId;
  const run = {
    id,
    name: c.name,
    status: "completed",
    conclusion: c.conclusion,
    job: true,
    workflow: c.workflow ?? "CI",
    html_url: `https://github.acme.example/${s.repo.owner}/${s.repo.name}/actions/runs/${RUN_ID}/job/${id}`,
  };

  s.jobs.set(id, {
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: c.step ?? "Run", conclusion: c.conclusion },
    ],
    log: jobLog(c),
  });

  s.checks.set(sha, [...(s.checks.get(sha) ?? []).filter((x) => x.name !== c.name), run]);
}

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

    /**
     * A human comments on the pull request conversation. `inFeed: false` holds the comment out of the events feed,
     * as a feed that lags would: only the direct comment list has it.
     */
    async comment(n: number, actor: string, body: string, inFeed = true) {
      addComment(s, needPull(s, n), actor, body, true);
      if (!inFeed) {
        s.events.shift();
      }
    },

    /**
     * A check run on the pull request's head commit, as a CI service would report it: completed with `conclusion`, or
     * still running for `pending`.
     */
    async setCheck(n: number, name: string, conclusion: string) {
      const pr = pullOf(s, n);
      const sha = pr && (await headSha(s, pr));
      if (!sha) {
        throw new Error(`Pull request ${n} has no head commit.`);
      }

      const run = {
        id: ++s.counters.checkId,
        name,
        ...(conclusion === "pending"
          ? { status: "in_progress", conclusion: null }
          : { status: "completed", conclusion }),
        html_url: `https://github.acme.example/${full}/runs/${name}`,
        output: { title: `${name} ${conclusion}`, summary: `${name} ${conclusion}` },
      };

      s.checks.set(sha, [...(s.checks.get(sha) ?? []).filter((c) => c.name !== name), run]);
    },

    /**
     * A human merges. `checks` are the CI's on the merge commit, there as soon as the merge is: each an Actions job
     * with a log the office can read.
     */
    /** A human closes the pull request without merging it. */
    async close(n: number, actor: string) {
      await closePull(s, needPull(s, n), actor, false);
    },

    /** The App may not list the pull requests of a further repository (`more`), until allowed again. */
    denyPulls(name: string, deny: boolean) {
      if (deny) {
        s.pullsDenied.add(name);
      } else {
        s.pullsDenied.delete(name);
      }
    },

    async merge(n: number, actor: string, checks: DriverCheck[] = []) {
      const pr = pullOf(s, n);
      if (!pr || pr.state !== "open") {
        throw new Error(`Pull request ${n} is not open.`);
      }

      await mergePull(s, pr, actor, `Merge pull request #${n}`);
      for (const c of checks) {
        jobCheck(s, pr.mergeCommitSha!, c);
      }
    },
  };
}

/**
 * The stand-in as the end-to-end stubs serve it: GitHub Enterprise paths, real time, Apps that sign their JWTs,
 * a real repository (plus `more`, for git only) served over smart HTTP, a ruleset that asks for one approval and
 * the ci check, a merge queue that merges 1.5 s after `merge-async` or an approval with auto-merge on, and the
 * controls the test driver acts through.
 */
export function createGithubE2e(opts: GithubE2eOptions) {
  const auth = appAuth(opts);
  const { store, routes } = createGithubStandIn({
    repo: { owner: opts.repo.owner, name: opts.repo.name },
    backend: opts.repo,
    now: realClock(),
    auth: () => auth,
    queueDelayMs: 1500,
    apiPrefix: "/api/v3",
    graphqlPath: "/api/graphql",
    more: opts.more ?? [],
    permissions: opts.permissions,
    ...(opts.logUrl ? { logUrl: opts.logUrl } : {}),
    mergeSettings: { queue: true, methods: ["merge", "squash"] },
    // The repository's ruleset requires one approval and the ci check; there is no classic protection.
    rules: [
      { type: "pull_request", parameters: { required_approving_review_count: 1 } },
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci" }] },
      },
    ],
  });

  const extensions = opts.extensions ?? [];
  const git = gitServer(store, auth, [opts.repo, ...(opts.more ?? []), ...extensions]);
  const all = [...extensionRoutes("/api/v3", extensions), ...routes];
  return {
    routes: all,
    dispatch: createRouter(all),
    isGitPath: git.isGitPath,
    serveGit: git.serveGit,
    ...controls(store),
    state: () => e2eState(store),
  };
}

import { createRouter } from "@outstaff/testing.http";
import { authRoutes } from "./auth-routes.js";
import { commentRoutes } from "./comment-routes.js";
import { fakeAuth } from "./fake-auth.js";
import { graphqlRoute } from "./graphql.js";
import { createMemoryRepo } from "./memory-repo.js";
import { mergeRoutes } from "./merge-routes.js";
import { pullRoutes } from "./pull-routes.js";
import { reactionRoutes } from "./reaction-routes.js";
import { moreRoutes, repoRoutes } from "./repo-routes.js";
import type { GithubStore, StandInOptions } from "./types.js";

/** A clock that starts at 2026-01-01T00:00:00Z and moves a second each time it is read. */
export function tickingClock(): () => string {
  let tick = 0;
  return () => new Date(Date.parse("2026-01-01T00:00:00Z") + ++tick * 1000).toISOString();
}

function createStore(opts: StandInOptions): GithubStore {
  return {
    repo: opts.repo,
    backend: opts.backend ?? createMemoryRepo(),
    now: opts.now ?? tickingClock(),
    counters: { eventId: 1000, thread: 0, review: 0, comment: 0, checkId: 5000, seq: 0 },
    prs: new Map(),
    checks: new Map(),
    jobs: new Map(),
    threads: new Map(),
    reviews: new Map(),
    issueComments: new Map(),
    reactions: [],
    perms: new Map(Object.entries(opts.permissions ?? {})),
    mergeSettings: opts.mergeSettings ?? { queue: false, methods: ["merge", "squash"] },
    events: [],
  };
}

/**
 * The parts of GitHub the vcs adapter uses: the App and installation endpoints, pull requests, reviews, comments
 * and reactions, checks and Actions logs, the events feed, and GraphQL. One implementation, served in process to
 * the adapter tests and over HTTP to the end-to-end run; what differs between them is injected through `opts`.
 */
export function createGithubStandIn(opts: StandInOptions) {
  const store = createStore(opts);
  const auth = (opts.auth ?? fakeAuth)(store);
  const api = opts.apiPrefix ?? "";
  const repo = `${api}/repos/${opts.repo.owner}/${opts.repo.name}`;
  const routes = [
    ...authRoutes(store, auth, api),
    ...mergeRoutes(store, auth, repo, opts.queueDelayMs),
    ...pullRoutes(store, auth, repo),
    ...commentRoutes(store, auth, repo),
    ...reactionRoutes(store, auth, repo),
    ...repoRoutes(store, repo),
    ...moreRoutes(store, api, opts.more ?? []),
    graphqlRoute(store, auth, opts.graphqlPath ?? "/graphql"),
  ];

  return { store, auth, routes, dispatch: createRouter(routes) };
}

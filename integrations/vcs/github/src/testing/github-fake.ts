import type { RepoRef } from "@outstaff/core";
import { createStubFetch } from "./http-stub.js";
import { authRoutes } from "./github-fake/auth-routes.js";
import { commentRoutes } from "./github-fake/comment-routes.js";
import { graphqlRoute } from "./github-fake/graphql-route.js";
import { pullRoutes } from "./github-fake/pull-routes.js";
import { repoRoutes } from "./github-fake/repo-routes.js";
import { createSeed } from "./github-fake/seed.js";
import { createFakeState } from "./github-fake/state.js";
import type { FakeVcsRef } from "./types.js";

/** A stateful stand-in for the parts of GitHub the adapter talks to, served through the route-table stub. */

export { OFFICE_APP, OWN_APP } from "./github-fake/requests.js";

export function createGithubFake(repo: RepoRef = { owner: "acme", name: "app" }) {
  const s = createFakeState(repo);
  const stub = createStubFetch([
    ...authRoutes(s),
    ...pullRoutes(s),
    ...commentRoutes(s),
    ...repoRoutes(s),
    graphqlRoute(s),
  ]);

  // Bound once the adapter exists.
  const vcsRef = {} as FakeVcsRef;
  const seed = createSeed(s, vcsRef);

  return {
    fetch: stub.fetch,
    seed,
    bind: (v: FakeVcsRef) => void Object.assign(vcsRef, v),
  };
}

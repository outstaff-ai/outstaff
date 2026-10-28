import type { RepoRef } from "@outstaff/core";
import { createStubFetch } from "./http-stub.js";
import { createSeed } from "./github-fake/seed.js";
import { createMemoryRepo } from "./stand-in/memory-repo.js";
import { createGithubStandIn } from "./stand-in/stand-in.js";
import type { FakeVcsRef, Route } from "./types.js";

export { OFFICE_APP, OWN_APP } from "./stand-in/fake-auth.js";

/** The GitHub stand-in in process: served through the stub fetch, with a seed and an in-memory repository. */
export function createGithubFake(repo: RepoRef = { owner: "acme", name: "app" }) {
  const git = createMemoryRepo();
  const { store, routes } = createGithubStandIn({ repo, backend: git });

  // A repository the Apps are not installed on, for the contract's forbidden call.
  const forbidden: Route = {
    method: "GET",
    path: `/repos/${repo.owner}/private/pulls/:n`,
    handler: () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
  };

  const stub = createStubFetch([forbidden, ...routes]);

  // Bound once the adapter exists.
  const vcsRef = {} as FakeVcsRef;
  return {
    fetch: stub.fetch,
    seed: createSeed(store, git, vcsRef),
    bind: (v: FakeVcsRef) => void Object.assign(vcsRef, v),
  };
}

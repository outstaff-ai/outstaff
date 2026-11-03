import type { DeriveContext, DoctorCheck } from "@outstaff/core";
import { call, mintToken } from "./api.js";
import { bad, ok } from "./findings.js";
import type { AppExpectation } from "./types.js";

/**
 * Whether to look for workflows: only a writer's own App pushes, and when the role changes CI the permission check
 * already requires Workflows.
 */
const probes = (want: AppExpectation) =>
  !want.readOnly && want.wantWrite && !want.wantWorkflows && want.repos.length > 0;

/**
 * The repositories of `want.repos` that have a `.github/workflows/` directory, read with an installation token. None
 * when the token cannot be minted; the repositories check reports that.
 */
export async function workflowRepos(
  ctx: DeriveContext,
  jwt: string,
  installationId: string,
  want: AppExpectation,
): Promise<string[]> {
  if (!probes(want)) {
    return [];
  }

  const token = await mintToken(ctx, jwt, installationId);
  if (typeof token === "number") {
    return [];
  }

  const found: string[] = [];
  for (const repo of want.repos) {
    const r = await call<unknown>(ctx, "GET", `/repos/${repo}/contents/.github/workflows`, token);
    if (r.ok) {
      found.push(repo);
    }
  }

  return found;
}

/** A writer's App on a repository with CI workflows needs Workflows: write, or GitHub refuses a push that changes one. */
export function workflowsCheck(
  want: AppExpectation,
  slug: string,
  granted: Record<string, string>,
  repos: string[],
): DoctorCheck[] {
  if (repos.length === 0) {
    return [];
  }

  const name = `${want.label}: workflows`;
  const where = repos.join(", ");
  if (granted["workflows"] === "write") {
    return [ok(name, `${slug} can change the CI workflows of ${where}.`)];
  }

  return [
    bad(
      "warn",
      name,
      `${slug} lacks workflows:write, and ${where} has .github/workflows/. GitHub refuses a push or pull request from this App that adds or changes a file there.`,
      `On the settings page of the ${slug} App, set Repository permissions > Workflows to "Read and write", then accept the new permissions on its installation. Leave it off only if this person must never change CI: such a push is then refused and the agent hands back blocked.`,
    ),
  ];
}

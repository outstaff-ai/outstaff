import type { DeriveContext, DoctorCheck } from "@outstaff/core";
import type { RestRule } from "#/api.types.js";
import { githubOptions } from "#/options.js";
import { call, mintToken } from "./api.js";
import { bad, ok } from "./findings.js";
import type { AppExpectation } from "./types.js";

/** Rules that stop the App committing to the branch directly; `creation` only while the branch does not exist. */
const BLOCKING = new Set([
  "update",
  "pull_request",
  "required_status_checks",
  "required_deployments",
  "merge_queue",
]);

/** The assets branch the options name; the default when they name none or one that does not parse. */
export function assetsBranchOf(options: unknown): string {
  const given = (options as { assetsBranch?: unknown } | undefined)?.assetsBranch;
  const parsed = githubOptions.shape.assetsBranch.safeParse(given);
  return parsed.success ? parsed.data : "outstaff-assets";
}

/** The rules of `repo` that would stop the App creating or pushing the branch; undefined when they cannot be read. */
async function blockingRules(
  ctx: DeriveContext,
  token: string,
  repo: string,
  branch: string,
): Promise<string[] | undefined> {
  const escaped = branch.split("/").map(encodeURIComponent).join("/");
  const rules = await call<RestRule[]>(
    ctx,
    "GET",
    `/repos/${repo}/rules/branches/${escaped}`,
    token,
  );

  if (!rules.ok || !Array.isArray(rules.data)) {
    return undefined;
  }

  const types = [...new Set(rules.data.map((r) => r.type))];
  const creates = types.includes("creation")
    ? !(await call<unknown>(ctx, "GET", `/repos/${repo}/git/ref/heads/${escaped}`, token)).ok
    : false;

  return types.filter((t) => BLOCKING.has(t) || (t === "creation" && creates));
}

/** Only a writer's own App stores images for pull requests. */
const stores = (want: AppExpectation) => !want.readOnly && want.wantWrite && want.repos.length > 0;

/**
 * Whether the repositories' rulesets let the App create and push the branch that holds the images agents attach to
 * pull requests (`ost pr attach`). A ruleset that restricts creating or updating branches, or asks for a pull
 * request or checks, applies to it as to any branch unless it is excluded.
 */
export async function assetsCheck(
  ctx: DeriveContext,
  jwt: string,
  installationId: string,
  want: AppExpectation,
  slug: string,
): Promise<DoctorCheck[]> {
  if (!stores(want)) {
    return [];
  }

  const token = await mintToken(ctx, jwt, installationId);
  if (typeof token === "number") {
    return [];
  }

  const branch = assetsBranchOf(ctx.options);
  const blocked: string[] = [];
  const read: string[] = [];
  for (const repo of want.repos) {
    const rules = await blockingRules(ctx, token, repo, branch);
    if (rules) {
      read.push(repo);
      blocked.push(...(rules.length ? [`${repo} (${rules.join(", ")})`] : []));
    }
  }

  return findings(want, slug, branch, blocked, read);
}

function findings(
  want: AppExpectation,
  slug: string,
  branch: string,
  blocked: string[],
  read: string[],
): DoctorCheck[] {
  const name = `${want.label}: assets branch`;
  if (blocked.length > 0) {
    return [
      bad(
        "warn",
        name,
        `Rulesets stop ${slug} creating or pushing ${branch}, the branch that holds the images agents attach to pull requests, on ${blocked.join("; ")}. ost pr attach is refused there, so screenshots stay on the ticket.`,
        `Exclude refs/heads/${branch} from those rulesets (Settings > Rules > Rulesets > the ruleset > Target branches > Exclude by pattern), or add the ${slug} App to their bypass list.`,
      ),
    ];
  }

  return read.length > 0
    ? [ok(name, `${slug} can create and push ${branch} on ${read.join(", ")}.`)]
    : [];
}

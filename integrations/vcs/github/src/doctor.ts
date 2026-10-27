import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { checkApp } from "./doctor/app.js";
import { bad, ok, repoName } from "./doctor/findings.js";
import type { AppExpectation } from "./doctor/types.js";
import { grantedRepos, needsWorkflows, writableRepos } from "./setup.js";

type Person = NonNullable<DeriveContext["person"]>;

/** A person's own App writes to the repositories they can write; the office App clones the ones they can read. */
function personApps(
  ctx: DeriveContext,
  person: Person,
  granted: ReturnType<typeof grantedRepos>,
): AppExpectation[] {
  // Reads and clones go through the office App; the own App only needs the repositories the person can write.
  const writable = writableRepos(ctx.team, person, ctx.profile);
  return [
    {
      prefix: "GH_APP_",
      label: "GitHub App",
      repos: writable.map((g) => repoName(g.repo.url)),
      exact: true,
      extraCanWrite: true,
      readOnly: false,
      wantWrite: writable.length > 0,
      wantWorkflows: writable.length > 0 && needsWorkflows(ctx),
      ...(person.identities?.vcs ? { login: person.identities.vcs } : {}),
    },
    // Agents clone read-granted repositories with the office App, which covers more than they are granted.
    {
      prefix: "GH_OFFICE_APP_",
      label: "Office GitHub App",
      repos: granted.map((g) => repoName(g.repo.url)),
      exact: false,
      readOnly: true,
      wantWrite: false,
    },
  ];
}

async function checkReachable(
  secrets: SecretSource,
  ctx: DeriveContext,
  app: AppExpectation,
): Promise<DoctorCheck[]> {
  try {
    return await checkApp(secrets, ctx, app);
  } catch (e) {
    return [
      bad(
        "fail",
        `${app.label}: reachable`,
        `GitHub could not be reached: ${(e as Error).message}`,
        "Check the network and the apiUrl option of the github integration.",
      ),
    ];
  }
}

async function checkApps(
  secrets: SecretSource,
  ctx: DeriveContext,
  apps: AppExpectation[],
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const app of apps) {
    out.push(...(await checkReachable(secrets, ctx, app)));
  }

  return out;
}

export async function doctorGithub(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  if (ctx.scope !== "person" || !ctx.person) {
    return checkApps(secrets, ctx, [
      {
        prefix: "GH_OFFICE_APP_",
        label: "Office GitHub App",
        repos: ctx.team.repos.map((r) => repoName(r.url)),
        exact: true,
        readOnly: true,
        wantWrite: false,
      },
    ]);
  }

  const granted = grantedRepos(ctx.team, ctx.person);
  if (granted.length === 0) {
    return [
      ok(
        "GitHub credentials",
        `${ctx.person.handle} has no repository grants, so no GitHub credentials are needed or checked.`,
      ),
    ];
  }

  return checkApps(secrets, ctx, personApps(ctx, ctx.person, granted));
}

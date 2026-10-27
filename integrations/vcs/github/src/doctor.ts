import type { DeriveContext, DoctorCheck, SecretSource } from "@outstaff/core";
import { checkApp } from "./doctor/app.js";
import { bad, ok, repoName } from "./doctor/findings.js";
import type { AppExpectation } from "./doctor/types.js";
import { grantedRepos, needsWorkflows, writableRepos } from "./setup.js";

export async function doctorGithub(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<DoctorCheck[]> {
  const apps: AppExpectation[] = [];
  if (ctx.scope === "person" && ctx.person) {
    const person = ctx.person;
    const granted = grantedRepos(ctx.team, person);
    if (granted.length === 0) {
      return [
        ok(
          "GitHub credentials",
          `${person.handle} has no repository grants, so no GitHub credentials are needed or checked.`,
        ),
      ];
    }

    // Reads and clones go through the office App; the own App only needs the repositories the person can write.
    const writable = writableRepos(ctx.team, person, ctx.profile);
    apps.push({
      prefix: "GH_APP_",
      label: "GitHub App",
      repos: writable.map((g) => repoName(g.repo.url)),
      exact: true,
      extraCanWrite: true,
      readOnly: false,
      wantWrite: writable.length > 0,
      wantWorkflows: writable.length > 0 && needsWorkflows(ctx),
      ...(person.identities?.vcs ? { login: person.identities.vcs } : {}),
    });

    // Agents clone read-granted repositories with the office App, which covers more than they are granted.
    apps.push({
      prefix: "GH_OFFICE_APP_",
      label: "Office GitHub App",
      repos: granted.map((g) => repoName(g.repo.url)),
      exact: false,
      readOnly: true,
      wantWrite: false,
    });
  } else {
    apps.push({
      prefix: "GH_OFFICE_APP_",
      label: "Office GitHub App",
      repos: ctx.team.repos.map((r) => repoName(r.url)),
      exact: true,
      readOnly: true,
      wantWrite: false,
    });
  }

  const out: DoctorCheck[] = [];
  for (const app of apps) {
    try {
      out.push(...(await checkApp(secrets, ctx, app)));
    } catch (e) {
      out.push(
        bad(
          "fail",
          `${app.label}: reachable`,
          `GitHub could not be reached: ${(e as Error).message}`,
          "Check the network and the apiUrl option of the github integration.",
        ),
      );
    }
  }

  return out;
}

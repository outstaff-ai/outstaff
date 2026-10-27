import type { DeriveContext, DoctorCheck } from "@outstaff/core";
import { installedRepos } from "./api.js";
import { bad, ok } from "./findings.js";
import type { AppExpectation, Installation } from "./types.js";

/** Whether the installation covers the repositories it should, and only those when it is meant to be narrow. */
export async function repositoryChecks(
  ctx: DeriveContext,
  jwt: string,
  installationId: string,
  want: AppExpectation,
  selection: Installation["repository_selection"],
  writes: string[],
): Promise<DoctorCheck[]> {
  const { label } = want;
  const out: DoctorCheck[] = [];
  if (selection === "all") {
    out.push(
      bad(
        "warn",
        `${label}: repositories`,
        "The App is installed on all repositories of the account.",
        want.extraCanWrite
          ? 'Change the installation to "Only select repositories" and pick exactly the ones this person can write.'
          : 'Change the installation to "Only select repositories" and pick exactly the granted ones.',
      ),
    );

    return out;
  }

  const have = await installedRepos(ctx, jwt, installationId);
  if (typeof have === "number") {
    out.push(
      bad(
        "fail",
        `${label}: repositories`,
        `GitHub answered ${have} when listing the repositories of installation ${installationId}.`,
        "Check the App is installed and its permissions were accepted.",
      ),
    );

    return out;
  }

  const missing = want.repos.filter((r) => !have.includes(r));
  const extra = have.filter((r) => !want.repos.includes(r));
  if (missing.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: repositories`,
        `The installation does not cover ${missing.join(", ")}.`,
        "Add those repositories to the App's installation.",
      ),
    );
  }

  // An own App without write permissions cannot write to extra repositories, so they are no finding.
  const warnExtra = want.exact && extra.length > 0 && (!want.extraCanWrite || writes.length > 0);
  if (warnExtra) {
    out.push(
      bad(
        "warn",
        `${label}: extra repositories`,
        want.extraCanWrite
          ? `The App can write to ${extra.join(", ")}, which this person may only read (or has no grant on).`
          : `The installation also covers ${extra.join(", ")}, which are not granted.`,
        "Remove those repositories from the installation.",
      ),
    );
  }

  if (missing.length === 0 && !warnExtra) {
    out.push(
      ok(
        `${label}: repositories`,
        want.repos.length === 0
          ? "The person needs no repositories on this App."
          : `The installation covers ${want.repos.join(", ")}.`,
      ),
    );
  }

  return out;
}

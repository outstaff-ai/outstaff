import type { DeriveContext, DoctorCheck } from "@outstaff/core";
import { installedRepos } from "./api.js";
import { bad, ok } from "./findings.js";
import type { AppExpectation, Installation } from "./types.js";

function missingCheck(want: AppExpectation, missing: string[]): DoctorCheck[] {
  if (missing.length === 0) {
    return [];
  }

  return [
    bad(
      "fail",
      `${want.label}: repositories`,
      `The installation does not cover ${missing.join(", ")}.`,
      "Add those repositories to the App's installation.",
    ),
  ];
}

function extraCheck(want: AppExpectation, extra: string[], writes: string[]): DoctorCheck[] {
  // An own App without write permissions cannot write to extra repositories, so they are no finding.
  if (!want.exact || extra.length === 0 || (want.extraCanWrite && writes.length === 0)) {
    return [];
  }

  return [
    bad(
      "warn",
      `${want.label}: extra repositories`,
      want.extraCanWrite
        ? `The App can write to ${extra.join(", ")}, which this person may only read (or has no grant on).`
        : `The installation also covers ${extra.join(", ")}, which are not granted.`,
      "Remove those repositories from the installation.",
    ),
  ];
}

function coverageChecks(want: AppExpectation, have: string[], writes: string[]): DoctorCheck[] {
  const missing = want.repos.filter((r) => !have.includes(r));
  const extra = have.filter((r) => !want.repos.includes(r));
  const findings = [...missingCheck(want, missing), ...extraCheck(want, extra, writes)];
  if (findings.length > 0) {
    return findings;
  }

  return [
    ok(
      `${want.label}: repositories`,
      want.repos.length === 0
        ? "The person needs no repositories on this App."
        : `The installation covers ${want.repos.join(", ")}.`,
    ),
  ];
}

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
  if (selection === "all") {
    return [
      bad(
        "warn",
        `${label}: repositories`,
        "The App is installed on all repositories of the account.",
        want.extraCanWrite
          ? 'Change the installation to "Only select repositories" and pick exactly the ones this person can write.'
          : 'Change the installation to "Only select repositories" and pick exactly the granted ones.',
      ),
    ];
  }

  const have = await installedRepos(ctx, jwt, installationId);
  if (typeof have === "number") {
    return [
      bad(
        "fail",
        `${label}: repositories`,
        `GitHub answered ${have} when listing the repositories of installation ${installationId}.`,
        "Check the App is installed and its permissions were accepted.",
      ),
    ];
  }

  return coverageChecks(want, have, writes);
}

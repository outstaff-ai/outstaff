import type { DoctorCheck } from "@outstaff/core";
import { bad, ok } from "./findings.js";
import type { AppExpectation } from "./types.js";

const READ_PERMISSIONS = [
  "metadata",
  "contents",
  "pull_requests",
  "issues",
  "checks",
  "statuses",
] as const;

const WRITE_PERMISSIONS = ["contents", "pull_requests", "issues"] as const;

/** What the installation was granted against what the grants and the role need. `writes` lists its write permissions. */
export function permissionChecks(
  want: AppExpectation,
  granted: Record<string, string>,
): { checks: DoctorCheck[]; writes: string[] } {
  const { label } = want;
  const out: DoctorCheck[] = [];
  const level = (p: string) => granted[p] ?? "none";
  const missingRead: string[] = READ_PERMISSIONS.filter((p) => level(p) === "none");
  const missingWrite: string[] = want.wantWrite
    ? WRITE_PERMISSIONS.filter((p) => level(p) !== "write")
    : [];

  // Writers read the logs of their failed CI jobs, which needs Actions: read (write also covers it).
  const missingActions = want.wantWrite && level("actions") === "none";
  if (missingActions) {
    missingRead.push("actions");
  }

  const missingWorkflows = want.wantWorkflows && level("workflows") !== "write";
  if (missingWorkflows) {
    missingWrite.push("workflows");
  }

  if (missingRead.length > 0 || missingWrite.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: permissions`,
        `The App lacks ${[
          ...missingRead.map((p) => `${p}:read`),
          ...missingWrite.map((p) => `${p}:write`),
        ].join(
          ", ",
        )}${want.wantWrite ? " (this person has a write grant)" : ""}${missingActions ? ". Without Actions: read, `ost pr checks` cannot show why a CI job failed" : ""}${missingWorkflows ? ". Without Workflows, GitHub refuses to push a change under .github/workflows/ (this person's role changes CI)" : ""}.`,
        "Edit the App's permissions, then accept the new permissions on the installation.",
      ),
    );
  } else {
    out.push(ok(`${label}: permissions`, "The App has the permissions the grants need."));
  }

  // Least privilege: a permission outside what the grants and the role need is advice, not a failure.
  const needed = new Set<string>([
    ...READ_PERMISSIONS,
    ...(want.wantWrite ? ["actions"] : []),
    ...(want.wantWorkflows ? ["workflows"] : []),
  ]);

  const surplus = Object.entries(granted)
    .filter(([name, v]) => v !== "none" && !needed.has(name))
    .map(([name, v]) => `${name}:${v}`);

  if (surplus.length > 0) {
    out.push(
      bad(
        "warn",
        `${label}: surplus permissions`,
        `The App has ${surplus.join(", ")}, which neither the grants nor this person's role need.`,
        "Remove those permissions from the App, then accept the change on the installation.",
      ),
    );
  }

  const writes = Object.entries(granted)
    .filter(([, v]) => v === "write" || v === "admin")
    .map(([k, v]) => `${k}:${v}`);

  if (want.readOnly && writes.length > 0) {
    out.push(
      bad(
        "fail",
        `${label}: read-only`,
        `The office App must be read-only but has ${writes.join(", ")}.`,
        "Set every permission of the office App to read-only (or no access).",
      ),
    );
  } else if (want.readOnly) {
    out.push(ok(`${label}: read-only`, "The App has no write permission."));
  } else if (!want.readOnly && !want.wantWrite && writes.length > 0) {
    out.push(
      bad(
        "warn",
        `${label}: unused write access`,
        `This person has no write grant but the App has ${writes.join(", ")}.`,
        "Reduce the App to read-only permissions.",
      ),
    );
  }

  return { checks: out, writes };
}

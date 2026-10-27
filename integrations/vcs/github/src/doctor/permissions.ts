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

interface Missing {
  read: string[];
  write: string[];

  /** Writers read the logs of their failed CI jobs, which needs Actions: read (write also covers it). */
  actions: boolean;
  workflows: boolean;
}

function missingPermissions(want: AppExpectation, granted: Record<string, string>): Missing {
  const level = (p: string) => granted[p] ?? "none";
  const actions = want.wantWrite && level("actions") === "none";
  const workflows = want.wantWorkflows === true && level("workflows") !== "write";
  const write = want.wantWrite ? WRITE_PERMISSIONS.filter((p) => level(p) !== "write") : [];
  return {
    read: [...READ_PERMISSIONS.filter((p) => level(p) === "none"), ...(actions ? ["actions"] : [])],
    write: [...write, ...(workflows ? ["workflows"] : [])],
    actions,
    workflows,
  };
}

function lacksDetail(want: AppExpectation, missing: Missing): string {
  const lacks = [
    ...missing.read.map((p) => `${p}:read`),
    ...missing.write.map((p) => `${p}:write`),
  ].join(", ");

  const notes: [boolean, string][] = [
    [want.wantWrite, " (this person has a write grant)"],
    [missing.actions, ". Without Actions: read, `ost pr checks` cannot show why a CI job failed"],
    [
      missing.workflows,
      ". Without Workflows, GitHub refuses to push a change under .github/workflows/ (this person's role changes CI)",
    ],
  ];

  return `The App lacks ${lacks}${notes.map(([on, note]) => (on ? note : "")).join("")}.`;
}

function grantCheck(want: AppExpectation, granted: Record<string, string>): DoctorCheck {
  const missing = missingPermissions(want, granted);
  if (missing.read.length === 0 && missing.write.length === 0) {
    return ok(`${want.label}: permissions`, "The App has the permissions the grants need.");
  }

  return bad(
    "fail",
    `${want.label}: permissions`,
    lacksDetail(want, missing),
    "Edit the App's permissions, then accept the new permissions on the installation.",
  );
}

/** Least privilege: a permission outside what the grants and the role need is advice, not a failure. */
function surplusCheck(want: AppExpectation, granted: Record<string, string>): DoctorCheck[] {
  const needed = new Set<string>([
    ...READ_PERMISSIONS,
    ...(want.wantWrite ? ["actions"] : []),
    ...(want.wantWorkflows ? ["workflows"] : []),
  ]);

  const surplus = Object.entries(granted)
    .filter(([name, v]) => v !== "none" && !needed.has(name))
    .map(([name, v]) => `${name}:${v}`);

  if (surplus.length === 0) {
    return [];
  }

  return [
    bad(
      "warn",
      `${want.label}: surplus permissions`,
      `The App has ${surplus.join(", ")}, which neither the grants nor this person's role need.`,
      "Remove those permissions from the App, then accept the change on the installation.",
    ),
  ];
}

function writeAccessCheck(want: AppExpectation, writes: string[]): DoctorCheck[] {
  const { label } = want;
  if (want.readOnly && writes.length > 0) {
    return [
      bad(
        "fail",
        `${label}: read-only`,
        `The office App must be read-only but has ${writes.join(", ")}.`,
        "Set every permission of the office App to read-only (or no access).",
      ),
    ];
  }

  if (want.readOnly) {
    return [ok(`${label}: read-only`, "The App has no write permission.")];
  }

  if (!want.wantWrite && writes.length > 0) {
    return [
      bad(
        "warn",
        `${label}: unused write access`,
        `This person has no write grant but the App has ${writes.join(", ")}.`,
        "Reduce the App to read-only permissions.",
      ),
    ];
  }

  return [];
}

/** What the installation was granted against what the grants and the role need. `writes` lists its write permissions. */
export function permissionChecks(
  want: AppExpectation,
  granted: Record<string, string>,
): { checks: DoctorCheck[]; writes: string[] } {
  const writes = Object.entries(granted)
    .filter(([, v]) => v === "write" || v === "admin")
    .map(([k, v]) => `${k}:${v}`);

  return {
    checks: [
      grantCheck(want, granted),
      ...surplusCheck(want, granted),
      ...writeAccessCheck(want, writes),
    ],
    writes,
  };
}

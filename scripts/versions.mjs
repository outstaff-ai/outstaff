#!/usr/bin/env node
// Dependencies are pinned to exact versions. `check` fails on any range in dependencies or
// devDependencies; `pin` rewrites ranges to the version pnpm resolved. peerDependencies keep
// ranges on purpose: they describe what a consumer may bring, not what we install.
// `check` also fails when a package.json does not declare the project licence.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
export const LICENSE_ID = "Apache-2.0";
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isPinned(spec) {
  return spec.startsWith("workspace:") || EXACT.test(spec);
}

export function findRanges(manifest) {
  const out = [];
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!isPinned(spec)) {
        out.push({ field, name, spec });
      }
    }
  }

  return out;
}

export function licenseIssue(manifest) {
  return manifest.license === LICENSE_ID ? null : `"license" must be "${LICENSE_ID}"`;
}

function projects() {
  return JSON.parse(
    execFileSync("pnpm", ["list", "-r", "--depth", "0", "--json"], { encoding: "utf8" }),
  );
}

function readManifest(project) {
  const file = path.join(project.path, "package.json");
  return { file, manifest: JSON.parse(readFileSync(file, "utf8")) };
}

/** Logs the project's problems and returns how many there are. */
function checkProject(project) {
  const { file, manifest } = readManifest(project);
  const where = path.relative(process.cwd(), file);
  const problems = findRanges(manifest).map(
    (r) => `${r.field}.${r.name} is "${r.spec}"; pin an exact version`,
  );

  const issue = licenseIssue(manifest);
  if (issue) {
    problems.unshift(issue);
  }

  for (const problem of problems) {
    console.error(`${where}: ${problem}`);
  }

  return problems.length;
}

/** Rewrites the project's ranges to the versions pnpm resolved. */
function pinProject(project) {
  const { file, manifest } = readManifest(project);
  const ranges = findRanges(manifest);
  for (const r of ranges) {
    const resolved = project[r.field]?.[r.name]?.version;
    if (!resolved || !EXACT.test(resolved)) {
      throw new Error(`${file}: cannot resolve ${r.name} (${r.spec})`);
    }

    manifest[r.field][r.name] = resolved;
  }

  if (ranges.length) {
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  }
}

function main(mode) {
  if (mode === "pin") {
    projects().forEach(pinProject);
    return;
  }

  const failed = projects().reduce((sum, project) => sum + checkProject(project), 0);
  if (failed) {
    console.error(
      `${failed} problem${failed === 1 ? "" : "s"} found. Pin dependencies with: node scripts/versions.mjs pin && pnpm install`,
    );

    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] === "pin" ? "pin" : "check");
}

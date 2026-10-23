#!/usr/bin/env node
// Dependencies are pinned to exact versions. `check` fails on any range in dependencies or
// devDependencies; `pin` rewrites ranges to the version pnpm resolved. peerDependencies keep
// ranges on purpose: they describe what a consumer may bring, not what we install.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isPinned(spec) {
  return spec.startsWith("workspace:") || EXACT.test(spec);
}

export function findRanges(manifest) {
  const out = [];
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!isPinned(spec)) out.push({ field, name, spec });
    }
  }
  return out;
}

function projects() {
  return JSON.parse(execFileSync("pnpm", ["list", "-r", "--depth", "0", "--json"], { encoding: "utf8" }));
}

function main(mode) {
  let failed = 0;
  for (const project of projects()) {
    const file = path.join(project.path, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const ranges = findRanges(manifest);
    if (mode === "check") {
      for (const r of ranges) console.error(`${path.relative(process.cwd(), file)}: ${r.field}.${r.name} is "${r.spec}"; pin an exact version`);
      failed += ranges.length;
      continue;
    }
    for (const r of ranges) {
      const resolved = project[r.field]?.[r.name]?.version;
      if (!resolved || !EXACT.test(resolved)) throw new Error(`${file}: cannot resolve ${r.name} (${r.spec})`);
      manifest[r.field][r.name] = resolved;
    }
    if (ranges.length) writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  }
  if (failed) {
    console.error(`${failed} unpinned dependenc${failed === 1 ? "y" : "ies"}. Run: node scripts/versions.mjs pin && pnpm install`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2] === "pin" ? "pin" : "check");

#!/usr/bin/env node
// Tests live in a `__tests__` folder inside the folder they test, and so does every helper only tests use. Fails on
// any tracked test file (`*.test.ts`, `*.test.mjs`) that sits elsewhere, and on any TypeScript file outside a
// `__tests__` folder that imports vitest, except the public test kits other packages import (PUBLIC_KITS).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TEST_FILE = /\.test\.(ts|mts|mjs|js)$/;
const TYPESCRIPT = /\.(ts|mts|tsx)$/;
const VITEST_IMPORT = /\b(?:from|import)\s*\(?\s*["']vitest["']/;

/** Public test kits: other packages import them through package.json exports, so they live outside `__tests__`. */
export const PUBLIC_KITS = [/^packages\/core\/src\/contracts\//, /^testing\/[^/]+\/src\//];

const inTests = (file) => file.split("/").includes("__tests__");

/** Returns the test files that are not inside a `__tests__` folder. */
export function misplacedTests(files) {
  return files.filter((file) => TEST_FILE.test(file) && !inTests(file));
}

/** Returns the TypeScript files outside `__tests__` and the public kits that import vitest. */
export function misplacedHelpers(files, read) {
  return files.filter(
    (file) =>
      TYPESCRIPT.test(file) &&
      !inTests(file) &&
      !PUBLIC_KITS.some((kit) => kit.test(file)) &&
      VITEST_IMPORT.test(read(file)),
  );
}

/** Prints each misplaced file with its advice and a count; returns how many there were. */
function report(files, advice, noun) {
  for (const file of files) {
    console.error(`${file}: ${advice}`);
  }

  if (files.length) {
    console.error(`${files.length} ${noun}${files.length === 1 ? "" : "s"} outside __tests__.`);
  }

  return files.length;
}

function main() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const helpers = misplacedHelpers(files, (file) => readFileSync(file, "utf8"));
  const failures =
    report(
      misplacedTests(files),
      "move it into a __tests__ folder next to the code it tests",
      "test file",
    ) +
    report(
      helpers,
      "imports vitest; move it into a __tests__ folder next to the code it serves",
      "test helper",
    );

  if (failures) {
    return 1;
  }

  console.log("Test layout check passed.");

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

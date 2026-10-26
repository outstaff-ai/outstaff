#!/usr/bin/env node
// Tests live in a `__tests__` folder inside the folder they test. Fails on any tracked test file
// (`*.test.ts`, `*.test.mjs`) that sits elsewhere.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TEST_FILE = /\.test\.(ts|mts|mjs|js)$/;

/** Returns the test files that are not inside a `__tests__` folder. */
export function misplacedTests(files) {
  return files.filter((file) => TEST_FILE.test(file) && !file.split("/").includes("__tests__"));
}

function main() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const misplaced = misplacedTests(files);
  for (const file of misplaced) {
    console.error(`${file}: move it into a __tests__ folder next to the code it tests`);
  }

  if (misplaced.length) {
    console.error(
      `${misplaced.length} test file${misplaced.length === 1 ? "" : "s"} outside __tests__.`,
    );

    return 1;
  }

  console.log("Test layout check passed.");

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

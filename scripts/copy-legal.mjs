#!/usr/bin/env node
// Runs as `prepack` in every published package: npm and pnpm always ship LICENSE and NOTICE from the
// package directory, so copy the root files in. The copies are git-ignored.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["LICENSE", "NOTICE"]) {
  copyFileSync(path.join(root, name), path.join(process.cwd(), name));
}

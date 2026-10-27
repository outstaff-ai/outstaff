import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "../define.js";
import {
  baseFile,
  tryIndex,
  setCatalogVersion,
  sha256,
  stockVersion,
  writeFileDeep,
  writeIndex,
} from "../ejected.js";
import { mergeThreeWay } from "../merge.js";
import { openTeam } from "../open-team.js";
import type { Context, EjectedIndex } from "../types.js";

type Outcome = "unchanged" | "updated" | "merged" | "conflict" | "deleted-upstream" | "reverted";
type FileResult = { path: string; outcome: Outcome };

/** The ejected catalog being upgraded to the installed stock version `target`. */
type Upgrade = { dir: string; stockDir: string; index: EjectedIndex; target: string };

/** Brings the client's copy up to the new stock text: takes it, merges it, or leaves the file alone. */
function mergeInto(clientPath: string, base: string, stock: string): Outcome {
  if (stock === base) {
    return "unchanged";
  }

  const ours = readFileSync(clientPath, "utf8");
  if (ours === base) {
    writeFileSync(clientPath, stock);
    return "updated";
  }

  const merged = mergeThreeWay(ours, base, stock);
  writeFileSync(clientPath, merged.text);
  return merged.conflicts ? "conflict" : "merged";
}

/** Upgrades one ejected file whose base exists, and moves its record to the new version. */
function upgradeFile(u: Upgrade, path: string): Outcome {
  const stockPath = join(u.stockDir, path);
  const clientPath = join(u.dir, path);
  const basePath = baseFile(u.dir, path);
  if (!existsSync(stockPath)) {
    return "deleted-upstream";
  }

  if (!existsSync(clientPath)) {
    rmSync(basePath);
    delete u.index[path];
    return "reverted";
  }

  const stock = readFileSync(stockPath, "utf8");
  const outcome = mergeInto(clientPath, readFileSync(basePath, "utf8"), stock);
  writeFileDeep(basePath, stock);
  u.index[path] = { version: u.target, sha256: sha256(stock) };
  return outcome;
}

/** Upgrades every ejected file; undefined (after printing why) when one has no stored base. */
function upgradeAll(ctx: Context, u: Upgrade): FileResult[] | undefined {
  const results: FileResult[] = [];
  for (const path of Object.keys(u.index)) {
    if (!existsSync(baseFile(u.dir, path))) {
      ctx.err(`error    ${path}: no stored base under .base/; re-eject it with --force.\n`);
      return undefined;
    }

    results.push({ path, outcome: upgradeFile(u, path) });
  }

  return results;
}

/** Sets catalog.version in the team file; false (after printing why) when it has none. */
function bumpCatalogVersion(ctx: Context, file: string, target: string): boolean {
  const yaml = readFileSync(file, "utf8");
  const bumped = setCatalogVersion(yaml, target);
  if (bumped === undefined) {
    ctx.err(`error    Cannot find catalog.version in ${file}; set it to ${target} by hand.\n`);
    return false;
  }

  if (bumped !== yaml) {
    writeFileSync(file, bumped);
  }

  return true;
}

function printResults(ctx: Context, json: boolean, results: FileResult[], target: string): void {
  if (json) {
    ctx.out(`${JSON.stringify({ version: target, files: results }, null, 2)}\n`);
    return;
  }

  for (const changed of results.filter((r) => r.outcome !== "unchanged")) {
    ctx.out(`${changed.outcome.padEnd(17)}${changed.path}\n`);
  }

  if (results.some((r) => r.outcome === "deleted-upstream")) {
    ctx.out(
      "Files marked deleted-upstream no longer exist in the stock catalog; they were kept.\n",
    );
  }

  ctx.out(`catalog.version is now ${target}\n`);
  const conflicts = results.filter((r) => r.outcome === "conflict");
  if (conflicts.length) {
    ctx.err(
      `error    ${conflicts.length} file${conflicts.length === 1 ? " has" : "s have"} conflicts; edit ${conflicts.map((c) => c.path).join(", ")} to resolve the <<<<<<< markers.\n`,
    );
  }
}

export const upgrade = defineCommand({
  name: "upgrade",
  summary: "Merge a newer stock catalog into the ejected files.",
  description:
    "For every ejected file, merges three ways: the recorded base, the installed stock file and your copy (git merge-file). Clean merges are written. Conflicts are written with standard conflict markers (client, base, stock) and listed; resolve them by editing the files. Recorded bases move to the new stock version and catalog.version in the team file is set to it. A file that no longer exists in the stock catalog is reported and left alone. A file you deleted is dropped from the record, so it follows stock again. The catalog is the one installed with this CLI; install the release you want first, then run this. --to must name that version.",
  options: [
    {
      flags: "--to <version>",
      description: "Expected target version; must equal the installed catalog version.",
    },
  ],
  examples: ["ost upgrade", "ost upgrade --to 1.2.0"],
  exitCodes: [
    "0: every file merged cleanly",
    "1: the team could not be loaded, --to does not match the installed catalog, or there are conflicts",
  ],
  async run(ctx, options) {
    const { to } = options as { to?: string };
    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { dir, stockDir, source } = opened.team;
    const target = stockVersion(stockDir);
    if (to !== undefined && to !== target) {
      ctx.err(
        `error    The installed catalog is ${target}, not ${to}. Install outstaff ${to} (or run the CLI from the ${to} image) and try again.\n`,
      );

      return 1;
    }

    const index = tryIndex(ctx, dir);
    if (!index) {
      return 1;
    }

    const results = upgradeAll(ctx, { dir, stockDir, index, target });
    if (!results) {
      return 1;
    }

    writeIndex(dir, index);
    if (!bumpCatalogVersion(ctx, source.file, target)) {
      return 1;
    }

    printResults(ctx, options.json === true, results, target);

    return results.some((r) => r.outcome === "conflict") ? 1 : 0;
  },
});

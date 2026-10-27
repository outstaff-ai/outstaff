import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "#/define.js";
import {
  allStockFiles,
  baseFile,
  tryIndex,
  resolveTarget,
  sha256,
  stockVersion,
  writeFileDeep,
  writeIndex,
} from "#/ejected.js";
import { openTeam } from "#/open-team.js";
import type { Context, EjectedIndex } from "#/types.js";

/** The stock files the targets name; undefined (after printing why) when a target matches nothing. */
function filesFor(ctx: Context, stockDir: string, targets: string[]): string[] | undefined {
  const files: string[] = [];
  for (const target of targets) {
    const found = resolveTarget(stockDir, target);
    if (!found) {
      ctx.err(
        `error    No stock role, process, reference, template or toolset matches "${target}".\n`,
      );

      return undefined;
    }

    files.push(...found);
  }

  return files;
}

/** Prints every file that is already ejected; true when there was one. */
function reportExisting(ctx: Context, dir: string, files: string[]): boolean {
  const existing = files.filter((f) => existsSync(join(dir, f)));
  for (const f of existing) {
    ctx.err(`error    ${f} already exists; pass --force to overwrite it.\n`);
  }

  return existing.length > 0;
}

/** Copies each stock file and its base into the ejected catalog and records it in the index. */
function copyFiles(
  stockDir: string,
  dir: string,
  files: string[],
  index: EjectedIndex,
  version: string,
): void {
  for (const f of files) {
    const text = readFileSync(join(stockDir, f), "utf8");
    writeFileDeep(join(dir, f), text);
    writeFileDeep(baseFile(dir, f), text);
    index[f] = { version, sha256: sha256(text) };
  }
}

function printEjected(
  ctx: Context,
  json: boolean,
  ejected: { version: string; dir: string; files: string[] },
): void {
  if (json) {
    ctx.out(`${JSON.stringify(ejected, null, 2)}\n`);
    return;
  }

  const { version, dir, files } = ejected;
  for (const f of files) {
    ctx.out(`ejected  ${f}\n`);
  }

  ctx.out(
    `Ejected ${files.length} file${files.length === 1 ? "" : "s"} (catalog ${version}) to ${dir}\n`,
  );
}

export const eject = defineCommand({
  name: "eject",
  summary: "Copy stock catalog files into the team repository to customize them.",
  description:
    "Copies stock catalog files into the ejected catalog (catalog.path next to the team file, .outstaff/catalog by default) and records, per file, the catalog version and hash they came from in .ejected.json, with a copy of the original under .base/. Ejected files win over stock files with the same path. Targets (one or more): a role name (all its files), process/<name>, references/<name>, templates/<name>, toolsets/<name>, or --all. Existing files are never overwritten unless --force is given. Use ost diff to see your changes and ost upgrade to merge a newer catalog.",
  args: "[targets...]",
  options: [
    {
      flags: "--all",
      description: "Eject every stock role, process, reference, template and toolset.",
    },
    {
      flags: "--force",
      description: "Overwrite files that already exist and reset their recorded base.",
    },
  ],
  examples: [
    "ost eject developer",
    "ost eject references/git",
    "ost eject process/review-loop",
    "ost eject --all",
    "ost eject developer --force",
  ],
  exitCodes: [
    "0: the files were copied",
    "1: the team could not be loaded, the target is unknown, or a file exists and --force was not given",
  ],
  async run(ctx, options, args) {
    const { all, force } = options as { all?: boolean; force?: boolean };
    const hasTargets = args.length > 0;
    if (Boolean(all) === hasTargets) {
      ctx.err("error    Give one or more targets, or --all.\n");
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { dir, stockDir } = opened.team;
    const files = all ? allStockFiles(stockDir) : filesFor(ctx, stockDir, args);
    if (!files) {
      return 1;
    }

    if (!force && reportExisting(ctx, dir, files)) {
      return 1;
    }

    const version = stockVersion(stockDir);
    const index = tryIndex(ctx, dir);
    if (!index) {
      return 1;
    }

    copyFiles(stockDir, dir, files, index, version);
    writeIndex(dir, index);
    printEjected(ctx, options.json === true, { version, dir, files });

    return 0;
  },
});

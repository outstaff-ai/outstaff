import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "../define.js";
import {
  allStockFiles,
  baseFile,
  openTeam,
  tryIndex,
  resolveTarget,
  sha256,
  stockVersion,
  writeFileDeep,
  writeIndex,
} from "../ejected.js";

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
    const files: string[] = [];
    if (all) {
      files.push(...allStockFiles(stockDir));
    } else {
      for (const target of args) {
        const found = resolveTarget(stockDir, target);
        if (!found) {
          ctx.err(
            `error    No stock role, process, reference, template or toolset matches "${target}".\n`,
          );

          return 1;
        }

        files.push(...found);
      }
    }

    const existing = files.filter((f) => existsSync(join(dir, f)));
    if (existing.length && !force) {
      for (const f of existing) {
        ctx.err(`error    ${f} already exists; pass --force to overwrite it.\n`);
      }

      return 1;
    }

    const version = stockVersion(stockDir);
    const index = tryIndex(ctx, dir);
    if (!index) {
      return 1;
    }

    for (const f of files) {
      const text = readFileSync(join(stockDir, f), "utf8");
      writeFileDeep(join(dir, f), text);
      writeFileDeep(baseFile(dir, f), text);
      index[f] = { version, sha256: sha256(text) };
    }

    writeIndex(dir, index);
    if (options.json) {
      ctx.out(`${JSON.stringify({ version, dir, files }, null, 2)}\n`);
    } else {
      for (const f of files) {
        ctx.out(`ejected  ${f}\n`);
      }

      ctx.out(
        `Ejected ${files.length} file${files.length === 1 ? "" : "s"} (catalog ${version}) to ${dir}\n`,
      );
    }

    return 0;
  },
});

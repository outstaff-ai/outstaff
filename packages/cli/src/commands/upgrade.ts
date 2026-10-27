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

type Outcome = "unchanged" | "updated" | "merged" | "conflict" | "deleted-upstream" | "reverted";

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

    const results: { path: string; outcome: Outcome }[] = [];
    for (const path of Object.keys(index)) {
      const stockPath = join(stockDir, path);
      const clientPath = join(dir, path);
      const basePath = baseFile(dir, path);
      if (!existsSync(basePath)) {
        ctx.err(`error    ${path}: no stored base under .base/; re-eject it with --force.\n`);
        return 1;
      }

      if (!existsSync(stockPath)) {
        results.push({ path, outcome: "deleted-upstream" });
        continue;
      }

      if (!existsSync(clientPath)) {
        rmSync(basePath);
        delete index[path];
        results.push({ path, outcome: "reverted" });
        continue;
      }

      const base = readFileSync(basePath, "utf8");
      const stock = readFileSync(stockPath, "utf8");
      const ours = readFileSync(clientPath, "utf8");
      let outcome: Outcome;
      if (stock === base) {
        outcome = "unchanged";
      } else if (ours === base) {
        writeFileSync(clientPath, stock);
        outcome = "updated";
      } else {
        const merged = mergeThreeWay(ours, base, stock);
        writeFileSync(clientPath, merged.text);
        outcome = merged.conflicts ? "conflict" : "merged";
      }

      writeFileDeep(basePath, stock);
      index[path] = { version: target, sha256: sha256(stock) };
      results.push({ path, outcome });
    }

    writeIndex(dir, index);

    const yaml = readFileSync(source.file, "utf8");
    const bumped = setCatalogVersion(yaml, target);
    if (bumped === undefined) {
      ctx.err(
        `error    Cannot find catalog.version in ${source.file}; set it to ${target} by hand.\n`,
      );

      return 1;
    }

    if (bumped !== yaml) {
      writeFileSync(source.file, bumped);
    }

    const conflicts = results.filter((r) => r.outcome === "conflict");
    if (options.json) {
      ctx.out(`${JSON.stringify({ version: target, files: results }, null, 2)}\n`);
    } else {
      for (const r of results) {
        if (r.outcome !== "unchanged") {
          ctx.out(`${r.outcome.padEnd(17)}${r.path}\n`);
        }
      }

      if (results.some((r) => r.outcome === "deleted-upstream")) {
        ctx.out(
          "Files marked deleted-upstream no longer exist in the stock catalog; they were kept.\n",
        );
      }

      ctx.out(`catalog.version is now ${target}\n`);
      if (conflicts.length) {
        ctx.err(
          `error    ${conflicts.length} file${conflicts.length === 1 ? " has" : "s have"} conflicts; edit ${conflicts.map((c) => c.path).join(", ")} to resolve the <<<<<<< markers.\n`,
        );
      }
    }

    return conflicts.length ? 1 : 0;
  },
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "../define.js";
import { EJECTABLE, badCatalogPath, baseFile, tryIndex } from "../ejected.js";
import { unifiedDiff } from "../merge.js";
import { openTeam } from "../open-team.js";

export const diff = defineCommand({
  name: "diff",
  summary: "Show how ejected catalog files differ from the stock version they came from.",
  description:
    "Prints a unified diff of each ejected file against its recorded base (the copy stored under .base/ when it was ejected or last upgraded). Without a path it covers every ejected file; with one it covers that file or every file below that folder, for example roles/developer. Files without changes are not listed.",
  args: "[path]",
  options: [],
  examples: ["ost diff", "ost diff roles/developer", "ost diff references/git.md"],
  exitCodes: [
    "0: the diff was printed (including when there are no changes)",
    "1: the team could not be loaded or the path is not an ejected file",
  ],
  async run(ctx, options, args) {
    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { dir } = opened.team;
    const index = tryIndex(ctx, dir);
    if (!index) {
      return 1;
    }

    const want = (args[0] ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
    if (
      want !== "" &&
      badCatalogPath(dir, want.replace(/\.md$/, "")) &&
      !EJECTABLE.includes(want as never)
    ) {
      ctx.err(`error    Invalid path "${want}".\n`);
      return 1;
    }

    const paths = Object.keys(index).filter(
      (p) => want === "" || p === want || p.startsWith(`${want}/`) || p === `${want}.md`,
    );

    if (!paths.length) {
      ctx.err(
        want === ""
          ? "error    Nothing is ejected; run ost eject first.\n"
          : `error    "${want}" is not an ejected file or folder.\n`,
      );

      return 1;
    }

    const changes: { path: string; status: "modified" | "deleted"; diff: string }[] = [];
    for (const p of paths) {
      const base = existsSync(baseFile(dir, p))
        ? readFileSync(baseFile(dir, p), "utf8")
        : undefined;

      if (base === undefined) {
        ctx.err(`warning  ${p}: no stored base under .base/; cannot diff.\n`);
        continue;
      }

      if (!existsSync(join(dir, p))) {
        changes.push({ path: p, status: "deleted", diff: unifiedDiff(p, base, "") });
        continue;
      }

      const d = unifiedDiff(p, base, readFileSync(join(dir, p), "utf8"));
      if (d) {
        changes.push({ path: p, status: "modified", diff: d });
      }
    }

    if (options.json) {
      ctx.out(`${JSON.stringify({ changes }, null, 2)}\n`);
    } else if (!changes.length) {
      ctx.out("No changes against the recorded bases.\n");
    } else {
      for (const c of changes) {
        ctx.out(c.status === "deleted" ? `# ${c.path}: deleted\n` : "");
        ctx.out(c.diff.endsWith("\n") ? c.diff : `${c.diff}\n`);
      }
    }

    return 0;
  },
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "#/define.js";
import { EJECTABLE, badCatalogPath, baseFile, tryIndex } from "#/ejected.js";
import { unifiedDiff } from "#/merge.js";
import { openTeam } from "#/open-team.js";
import type { Context } from "#/types.js";

type Change = { path: string; status: "modified" | "deleted"; diff: string };

/** The path argument without a leading `./` or trailing slashes; "" for every ejected file. */
const normalizePath = (arg: string | undefined): string =>
  (arg ?? "").replace(/^\.\//, "").replace(/\/+$/, "");

/** Whether `want` is neither a catalog path nor an ejectable folder. */
const isInvalidPath = (dir: string, want: string): boolean =>
  want !== "" &&
  Boolean(badCatalogPath(dir, want.replace(/\.md$/, ""))) &&
  !EJECTABLE.includes(want as never);

/** Whether the ejected file `p` is `want`, lies below it, or is its `.md` file. */
const isSelected = (p: string, want: string): boolean =>
  want === "" || p === want || p.startsWith(`${want}/`) || p === `${want}.md`;

/** How one ejected file differs from its base; undefined when it has no base or no changes. */
function changeOf(ctx: Context, dir: string, p: string): Change | undefined {
  if (!existsSync(baseFile(dir, p))) {
    ctx.err(`warning  ${p}: no stored base under .base/; cannot diff.\n`);
    return undefined;
  }

  const base = readFileSync(baseFile(dir, p), "utf8");
  if (!existsSync(join(dir, p))) {
    return { path: p, status: "deleted", diff: unifiedDiff(p, base, "") };
  }

  const d = unifiedDiff(p, base, readFileSync(join(dir, p), "utf8"));
  return d ? { path: p, status: "modified", diff: d } : undefined;
}

function printChanges(ctx: Context, changes: Change[]): void {
  if (!changes.length) {
    ctx.out("No changes against the recorded bases.\n");
    return;
  }

  for (const c of changes) {
    ctx.out(c.status === "deleted" ? `# ${c.path}: deleted\n` : "");
    ctx.out(c.diff.endsWith("\n") ? c.diff : `${c.diff}\n`);
  }
}

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

    const want = normalizePath(args[0]);
    if (isInvalidPath(dir, want)) {
      ctx.err(`error    Invalid path "${want}".\n`);
      return 1;
    }

    const paths = Object.keys(index).filter((p) => isSelected(p, want));
    if (!paths.length) {
      ctx.err(
        want === ""
          ? "error    Nothing is ejected; run ost eject first.\n"
          : `error    "${want}" is not an ejected file or folder.\n`,
      );

      return 1;
    }

    const changes = paths.flatMap((p) => changeOf(ctx, dir, p) ?? []);
    if (options.json) {
      ctx.out(`${JSON.stringify({ changes }, null, 2)}\n`);
    } else {
      printChanges(ctx, changes);
    }

    return 0;
  },
});

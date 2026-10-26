import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileDeep } from "./ejected.js";
import type { MergeResult } from "./types.js";

/** Conflict markers left in a file by `ost upgrade`. */
export const hasConflictMarkers = (text: string): boolean =>
  /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);

/** Three-way merge with `git merge-file`; conflicts use standard markers. */
export function mergeThreeWay(ours: string, base: string, theirs: string): MergeResult {
  const tmp = mkdtempSync(join(tmpdir(), "ost-merge-"));
  try {
    const files = {
      ours: join(tmp, "client"),
      base: join(tmp, "base"),
      theirs: join(tmp, "stock"),
    };

    writeFileSync(files.ours, ours);
    writeFileSync(files.base, base);
    writeFileSync(files.theirs, theirs);
    const r = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "-L",
        "client",
        "-L",
        "base",
        "-L",
        "stock",
        files.ours,
        files.base,
        files.theirs,
      ],
      { encoding: "utf8" },
    );

    if (r.error) {
      throw new Error(`Cannot run git: ${r.error.message}`);
    }

    if (r.status === null || r.status < 0 || r.status > 127) {
      throw new Error(`git merge-file failed: ${r.stderr.trim()}`);
    }

    return { text: r.stdout, conflicts: r.status };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Unified diff of two texts, headed `a/<path>` and `b/<path>`; empty when equal. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }

  const tmp = mkdtempSync(join(tmpdir(), "ost-diff-"));
  try {
    writeFileDeep(join(tmp, "a", path), before);
    writeFileDeep(join(tmp, "b", path), after);
    const r = spawnSync(
      "git",
      [
        "-c",
        "core.quotepath=off",
        "diff",
        "--no-index",
        "--no-color",
        "--no-prefix",
        "--no-ext-diff",
        `a/${path}`,
        `b/${path}`,
      ],
      { cwd: tmp, encoding: "utf8" },
    );

    if (r.error) {
      throw new Error(`Cannot run git: ${r.error.message}`);
    }

    // Drop the "diff --git" and "index" lines; keep from "---" on.
    const lines = r.stdout.split("\n");
    const start = lines.findIndex((l) => l.startsWith("--- "));
    return start < 0 ? r.stdout : lines.slice(start).join("\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

#!/usr/bin/env node
// Source files stay small and keep types apart from implementations. Fails on a source file over
// MAX_LINES lines, and on a non-index file that exports both a type (or interface) and a runtime
// value. Shared types go in a folder's `types.ts`, a larger contract in `<name>.types.ts`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_LINES = 300;

// TypeScript source anywhere in the repository. Tests and type declarations are not checked; the
// repository has no generated TypeScript (generated JSON schema and docs are not source).
const SOURCE = /\.(ts|tsx|mts)$/;
const SKIPPED = [/(^|\/)__tests__\//, /\.d\.ts$/, /(^|\/)node_modules\//];

/** Paths (a trailing slash covers a folder) the check skips, each with the reason. */
export const EXEMPT = new Map([
  ["packages/office/src/engine/", "deleted by the event-pipeline redesign"],
  ["packages/core/src/workflow/presets.ts", "deleted by the event-pipeline redesign"],
  ["packages/core/src/workflow/resolve.ts", "deleted by the event-pipeline redesign"],
  ["packages/core/src/policies/switches.ts", "deleted by the event-pipeline redesign"],
  ["packages/office/src/chat/desk.ts", "chat desk routing, deleted by the event-pipeline redesign"],
  ["e2e/", "end-to-end test harness (driver, stubs, scripted runtime), not shipped"],
]);

/** Whether the file is product source the check covers. */
export function isSource(file) {
  return SOURCE.test(file) && !SKIPPED.some((pattern) => pattern.test(file));
}

/** The exemption reason for a file, if any. */
export function exemption(file) {
  for (const [prefix, reason] of EXEMPT) {
    if (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix) {
      return reason;
    }
  }

  return undefined;
}

/** Whether the file is an entry point that may re-export both types and values. */
export function isIndex(file) {
  return /(^|\/)index\.(ts|tsx|mts)$/.test(file);
}

/** Classifies a module's exports: whether it exports types and whether it exports runtime values. */
export function exportKinds(source) {
  let types = false;
  let values = false;

  // Top-level export statements start a line; the formatter guarantees it.
  for (const match of source.matchAll(/^export\s+(type\s+|declare\s+)?(\S+)/gm)) {
    const [, modifier = "", head] = match;

    if (modifier.startsWith("type") && !head.startsWith("{") && !head.startsWith("*")) {
      types = true;
    } else if (/^(interface|type)$/.test(head)) {
      types = true;
    } else if (head.startsWith("{")) {
      const list = source.slice(match.index).match(/^export\s+(type\s+)?\{([^}]*)\}/);
      const names = (list?.[2] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);

      for (const name of names) {
        if (list?.[1] || name.startsWith("type ")) {
          types = true;
        } else {
          values = true;
        }
      }
    } else if (head.startsWith("*")) {
      if (modifier.startsWith("type")) {
        types = true;
      } else {
        values = true;
      }
    } else {
      values = true;
    }
  }

  return { types, values };
}

/** Returns the problems in the given files, read with `read`. */
export function layoutProblems(files, read) {
  const problems = [];

  for (const file of files.filter(isSource)) {
    const source = read(file);
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);

    if (exemption(file)) {
      continue;
    }

    if (lines > MAX_LINES) {
      problems.push(`${file}: ${lines} lines, over ${MAX_LINES}; split it along its seams`);
    }

    if (!isIndex(file)) {
      const { types, values } = exportKinds(source);

      if (types && values) {
        problems.push(
          `${file}: exports types and runtime values; move the types to types.ts or <name>.types.ts`,
        );
      }
    }
  }

  return problems;
}

function main() {
  // Untracked files count too, so a split is checked before it is staged.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && existsSync(file));

  const problems = layoutProblems(files, (file) => readFileSync(file, "utf8"));
  for (const problem of problems) {
    console.error(problem);
  }

  if (problems.length) {
    console.error(`${problems.length} file layout problem${problems.length === 1 ? "" : "s"}.`);

    return 1;
  }

  console.log("File layout check passed.");

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

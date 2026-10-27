import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PortError, evaluate, type Policy } from "@outstaff/core";
import { safeId } from "../repos/workspaces.js";
import type { AgentEnv, VerbContext } from "./types.js";

const MAX_FILE = 1_000_000;

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/**
 * Text of a file the caller names (`--body-file`, `--comment-file`), which a verb then publishes. A file is
 * read only when it is under the item's worktree or scratch directory AND the person's Policy lets the Read
 * tool read it, both as named and after symlinks. Refusals never include file content.
 */
export function readInputFile(env: AgentEnv, ctx: VerbContext, path: string, what: string): string {
  const target = checkedPath(env, ctx, path, what, true);
  try {
    const text = readFileSync(target, "utf8");
    if (text.length > MAX_FILE) {
      throw new PortError(
        "invalid",
        `Refusing to read ${what} ${path}: it is larger than ${MAX_FILE} characters.`,
      );
    }

    return text;
  } catch (e) {
    if (e instanceof PortError) {
      throw e;
    }

    throw new PortError("invalid", `Cannot read ${what} ${path}.`, { cause: e });
  }
}

/**
 * The bytes of a file the caller names (`ost ticket attach`), under the same rules as `readInputFile` except that a
 * chat session, which has no worktree, may name files in its scratch directory. At most `max` bytes.
 */
export function readInputBytes(
  env: AgentEnv,
  ctx: VerbContext,
  path: string,
  what: string,
  max: number,
): Uint8Array {
  const target = checkedPath(env, ctx, path, what, false);
  try {
    if (statSync(target).size > max) {
      throw new PortError(
        "invalid",
        `Refusing to read ${what} ${path}: it is larger than ${max} bytes.`,
      );
    }

    return new Uint8Array(readFileSync(target));
  } catch (e) {
    if (e instanceof PortError) {
      throw e;
    }

    throw new PortError("invalid", `Cannot read ${what} ${path}.`, { cause: e });
  }
}

/** Whether the call has the worktree it needs: always, unless a worktree is required and there is none. */
const hasWorkdir = (ctx: VerbContext, needCwd: boolean) => !needCwd || !!ctx.cwd;

/** The item's scratch directory, or the person's when the call belongs to no item. */
function scratchDirOf(scratchDir: string, ctx: VerbContext): string {
  return ctx.workItemId ? join(scratchDir, safeId(ctx.workItemId)) : scratchDir;
}

/** Whether `target` is under the worktree or the scratch directory, both resolved through symlinks. */
function underRoots(roots: (string | undefined)[], target: string): boolean {
  return roots
    .filter((r): r is string => !!r)
    .map((r) => real(r) ?? r)
    .some((r) => inside(r, target));
}

/** Whether the Policy lets the Read tool read every one of `paths`. */
function readAllowed(policy: Policy, paths: Set<string>, cwd: string): boolean {
  return [...paths].every(
    (p) => evaluate(policy, { kind: "read", path: p, cwd }).effect === "allow",
  );
}

function checkedPath(
  env: AgentEnv,
  ctx: VerbContext,
  path: string,
  what: string,
  needCwd: boolean,
): string {
  const refuse = (why: string): never => {
    throw new PortError("invalid", `Refusing to read ${what} ${path}: ${why}`);
  };

  const { policy, layout } = env;
  if (!policy || !layout || !hasWorkdir(ctx, needCwd)) {
    return refuse("reading files is not available here; pass the text inline instead.");
  }

  const scratch = scratchDirOf(layout.scratchDir, ctx);
  const base = ctx.cwd ?? scratch;
  const named = resolve(base, path);
  const target = real(named);
  if (!target) {
    return refuse("no such file.");
  }

  if (!underRoots([ctx.cwd, scratch], target)) {
    return refuse("it is outside the worktree and the scratch directory of this item.");
  }

  if (!readAllowed(policy, new Set([named, target]), base)) {
    return refuse("the read policy does not allow it.");
  }

  return target;
}

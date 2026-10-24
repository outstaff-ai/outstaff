import { realpathSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PortError, evaluate } from "@outstaff/core";
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
  const refuse = (why: string): never => {
    throw new PortError("invalid", `Refusing to read ${what} ${path}: ${why}`);
  };

  if (!env.policy || !env.layout || !ctx.cwd) {
    return refuse("reading files is not available here; pass the text inline instead.");
  }

  const scratch = ctx.workItemId
    ? join(env.layout.scratchDir, safeId(ctx.workItemId))
    : env.layout.scratchDir;

  const named = resolve(ctx.cwd, path);
  const target = real(named);
  if (!target) {
    return refuse("no such file.");
  }

  const roots = [ctx.cwd, scratch].map((r) => real(r) ?? r);
  if (!roots.some((r) => inside(r, target))) {
    return refuse("it is outside the worktree and the scratch directory of this item.");
  }

  for (const p of new Set([named, target])) {
    const decision = evaluate(env.policy, { kind: "read", path: p, cwd: ctx.cwd });
    if (decision.effect !== "allow") {
      return refuse("the read policy does not allow it.");
    }
  }

  try {
    const text = readFileSync(target, "utf8");
    if (text.length > MAX_FILE) {
      return refuse(`it is larger than ${MAX_FILE} characters.`);
    }

    return text;
  } catch (e) {
    throw new PortError("invalid", `Cannot read ${what} ${path}.`, { cause: e });
  }
}

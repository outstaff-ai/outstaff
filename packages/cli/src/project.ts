import { basename, dirname, join, relative, resolve } from "node:path";
import type { ConfigSource } from "@outstaff/core";
import type { Context, GlobalOptions, SecretsLocation } from "./types.js";

/** The project the team file belongs to: the parent of `.outstaff/`, else the directory holding the team file. A team fetched from git is not written to, so the current directory stands in. */
export function projectRoot(ctx: Context, source: ConfigSource): string {
  if (source.kind === "git") {
    return ctx.cwd;
  }

  return basename(source.dir) === ".outstaff" ? dirname(source.dir) : source.dir;
}

/**
 * `--secrets-dir`, then OUTSTAFF_SECRETS_DIR, name one directory holding the files of a scope, as in a container.
 * Without either, the project keeps all scopes under `.outstaff/secrets/<handle|office>/`.
 */
export function secretsLocation(
  ctx: Context,
  options: GlobalOptions & { secretsDir?: string },
  root: string,
  scope: string,
): SecretsLocation {
  const given = options.secretsDir ?? ctx.env["OUTSTAFF_SECRETS_DIR"];
  if (given) {
    const dir = resolve(ctx.cwd, given);
    return { dir, ignoreDir: dir };
  }

  const ignoreDir = join(root, ".outstaff", "secrets");
  return { dir: join(ignoreDir, scope), ignoreDir };
}

/** A path as shown to people: relative to the current directory when inside it. */
export function shown(ctx: Context, path: string): string {
  const rel = relative(ctx.cwd, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

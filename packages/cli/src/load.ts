import { relative } from "node:path";
import { loadTeamConfig, parseYaml, type ConfigIssue, type LocatedIssue } from "@outstaff/core";
import { readFileSync } from "node:fs";
import type { Context, GlobalOptions, Loaded } from "./types.js";

export async function loadTeam(ctx: Context, options: GlobalOptions): Promise<Loaded> {
  const result = await loadTeamConfig({
    cwd: ctx.cwd,
    env: ctx.env,
    ...(options.team !== undefined ? { team: options.team } : {}),
    ...(ctx.fs ? { fs: ctx.fs } : {}),
    ...(ctx.git ? { git: ctx.git } : {}),
    ...(ctx.cacheDir ? { cacheDir: ctx.cacheDir } : {}),
  });

  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }

  const rel = relative(ctx.cwd, result.source.file);
  const file = rel === "" || rel.startsWith("..") ? result.source.file : rel;
  let parsed: ReturnType<typeof parseYaml> | undefined;
  try {
    parsed = parseYaml(readFileSync(result.source.file, "utf8"));
  } catch {
    parsed = undefined;
  }

  const locate = (issue: ConfigIssue): LocatedIssue => ({
    ...issue,
    file,
    ...(parsed?.locate(issue) ?? { line: 1, column: 1 }),
  });

  return { ok: true, config: result.config, source: result.source, raw: parsed?.value, locate };
}

export const issueJson = (i: LocatedIssue & { consequence?: string }) => ({
  code: i.code,
  message: i.message,
  ...(i.consequence !== undefined ? { consequence: i.consequence } : {}),
  file: i.file,
  line: i.line,
  column: i.column,
  path: i.path,
});

import { relative } from "node:path";
import { loadTeamConfig, parseYaml, type ConfigIssue, type LocatedIssue } from "@outstaff/core";
import { readFileSync } from "node:fs";
import type { Context, GlobalOptions, Loaded } from "./types.js";

const loadOptions = (ctx: Context, options: GlobalOptions) => ({
  cwd: ctx.cwd,
  env: ctx.env,
  ...(options.team !== undefined ? { team: options.team } : {}),
  ...(ctx.fs ? { fs: ctx.fs } : {}),
  ...(ctx.git ? { git: ctx.git } : {}),
  ...(ctx.cacheDir ? { cacheDir: ctx.cacheDir } : {}),
});

/** The team file as issues show it: relative to the working directory when it is inside it. */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel;
}

/** The team file parsed for issue locations, or undefined when it cannot be read again. */
function parseForLocations(file: string): ReturnType<typeof parseYaml> | undefined {
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function loadTeam(ctx: Context, options: GlobalOptions): Promise<Loaded> {
  const result = await loadTeamConfig(loadOptions(ctx, options));
  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }

  const file = displayPath(ctx.cwd, result.source.file);
  const parsed = parseForLocations(result.source.file);
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

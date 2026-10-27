import { formatIssue } from "@outstaff/core";
import { stockCatalogDir } from "./catalogs.js";
import { ejectedDir } from "./ejected.js";
import { loadTeam } from "./load.js";
import type { Context, GlobalOptions, OpenedTeam } from "./types.js";

/** Loads the team and locates the ejected catalog; prints the errors and returns an exit code on failure. */
export async function openTeam(
  ctx: Context,
  options: GlobalOptions,
): Promise<{ ok: true; team: OpenedTeam } | { ok: false; code: number }> {
  const loaded = await loadTeam(ctx, options);
  if (!loaded.ok) {
    for (const i of loaded.issues) {
      ctx.err(`error    ${formatIssue(i)}\n`);
    }

    return { ok: false, code: 1 };
  }

  if (loaded.source.kind !== "file") {
    ctx.err("error    This command edits files, so --team must be a local path, not a git URL.\n");
    return { ok: false, code: 1 };
  }

  return {
    ok: true,
    team: {
      config: loaded.config,
      source: loaded.source,
      dir: ejectedDir(loaded.source.dir, loaded.config),
      stockDir: stockCatalogDir(ctx),
    },
  };
}

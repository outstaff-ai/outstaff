import type { EffectiveTool } from "@outstaff/core";
import { dataDirOf, lastLine, miseKey, runMise } from "./mise.js";
import type { MiseResult, MiseRunner, ToolStatus } from "./types.js";

const bare = (v: string) => v.replace(/^v/, "");

/** Why the declared version of a tool is not the active one, or undefined when it is. */
function inactiveReason(active: MiseResult, version: string): string | undefined {
  if (active.code !== 0) {
    return lastLine(active);
  }

  if (active.stdout.split(/\s+/).some((v) => bare(v) === bare(version))) {
    return undefined;
  }

  const current = active.stdout.trim();

  return `no version is active; the global mise config does not set it${current ? ` (active: ${current})` : ""}`;
}

/** Why a tool does not resolve: its version is not active, or not installed. Undefined when it resolves. */
async function unresolvedReason(
  run: (args: string[]) => Promise<MiseResult>,
  t: EffectiveTool,
): Promise<string | undefined> {
  const key = miseKey(t);
  const inactive = inactiveReason(await run(["current", key]), t.version);
  if (inactive) {
    return inactive;
  }

  const installed = await run(["where", `${key}@${t.version}`]);

  return installed.code !== 0 ? lastLine(installed) : undefined;
}

/**
 * Asks mise, from the home directory (outside any repo and outside the generated project config), which version of
 * each tool is active and whether it is installed. An installed tool that no config sets a version for is the
 * failure a shim reports on first use ("mise use -g ..."). Returns the tools that do not resolve, with the reason.
 */
export async function verifyTools(opts: {
  tools: EffectiveTool[];
  home: string;
  env?: NodeJS.ProcessEnv;
  mise?: MiseRunner;
}): Promise<ToolStatus[]> {
  const mise = opts.mise ?? runMise;
  const base = opts.env ?? process.env;
  const env = { ...base, MISE_DATA_DIR: dataDirOf(opts.home, base), MISE_YES: "1" };
  const run = (args: string[]) => mise(args, { cwd: opts.home, env });
  const failed: ToolStatus[] = [];
  for (const t of opts.tools) {
    const why = await unresolvedReason(run, t);
    if (why) {
      failed.push({
        name: t.name,
        version: t.version,
        state: "unavailable",
        error: `${t.name}@${t.version} does not resolve: ${why}`,
      });
    }
  }

  return failed;
}

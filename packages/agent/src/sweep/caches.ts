import { existsSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@outstaff/core";
import { WARN_AT, volumeUsage } from "#/doctor/disk.js";
import { cacheHome, dataHome, humanSize, measureFolders } from "#/home/index.js";
import { lastLine, runProgram } from "#/tools/mise.js";
import { removeOlderThan } from "./old-files.js";
import type { CachePruner, CachePrunerOptions, CacheRule, PrunedCache } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A tool walking a large store gets time, but not forever. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The tool caches the sweep prunes, by what each costs to rebuild. A rule applies only when its folder exists and its
 * tool runs from the agent's home; adding a tool is adding a rule.
 */
export const CACHE_RULES: CacheRule[] = [
  {
    // Installed tools never read their download archives again, and an install running now keeps its own. The rest of
    // mise's cache stays: a shim resolves through it, and rebuilding it needs the network an agent may not have.
    tool: "mise",
    folder: (home, env) => env["MISE_CACHE_DIR"] || join(cacheHome(home, env), "mise"),
    olderThan: { below: "downloads-cas", ms: HOUR_MS },
    when: "every_sweep",
  },
  {
    // Packages no project on disk links to any more.
    tool: "pnpm",
    folder: (home, env) => join(dataHome(home, env), "pnpm"),
    command: ["store", "prune"],
    when: "short_of_space",
  },
  {
    // Entries not written for 30 days, then the content nothing refers to any more.
    tool: "npm",
    folder: (home, env) => env["npm_config_cache"] || join(home, ".npm"),
    olderThan: { below: "_cacache/index-v5", ms: 30 * DAY_MS },
    command: ["cache", "verify"],
    when: "short_of_space",
  },
];

/**
 * Prunes the caches of {@link CACHE_RULES} (or `opts.rules`) after each sweep. A rule's folder that does not exist is
 * skipped, then its tool is asked for `--version` in the agent's home: a tool that is not installed, or whose shim
 * resolves no version there, is skipped quietly. A rule for `every_sweep` runs on every sweep; one for
 * `short_of_space` only while the home volume is over the doctor's warning share. Each removes its files older than
 * its age first, then runs its command.
 */
export function createCachePruner(opts: CachePrunerOptions): CachePruner {
  const run = opts.run ?? runProgram;
  const volume = opts.volume ?? volumeUsage;
  const measure = opts.measure ?? measureFolders;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? silentLogger;
  const rules = opts.rules ?? CACHE_RULES;
  const at = { cwd: opts.home, env: opts.env, timeoutMs: STEP_TIMEOUT_MS };

  const size = async (path: string) => (await measure([{ name: path, path }]))[0]?.bytes ?? 0;

  const shortOfSpace = async () => {
    const u = await volume(opts.home).catch(() => undefined);
    return u !== undefined && u.total > 0 && u.used / u.total >= WARN_AT;
  };

  /** Prunes one rule's folder and measures what it freed; undefined when the rule does not apply. */
  async function apply(rule: CacheRule): Promise<PrunedCache | undefined> {
    const folder = rule.folder(opts.home, opts.env);
    const target = rule.olderThan ? join(folder, rule.olderThan.below) : folder;
    if (!existsSync(target) || (await run(rule.tool, ["--version"], at)).code !== 0) {
      return undefined;
    }

    const was = await size(folder);
    if (rule.olderThan) {
      await removeOlderThan(target, now() - rule.olderThan.ms);
    }

    if (rule.command) {
      const r = await run(rule.tool, rule.command, at);
      if (r.code !== 0) {
        log.warn("could not prune a cache", { cache: rule.tool, error: lastLine(r) });
      }
    }

    return { cache: rule.tool, freed: Math.max(0, was - (await size(folder))) };
  }

  return {
    async prune() {
      const due = rules.some((r) => r.when === "short_of_space") && (await shortOfSpace());
      const done: PrunedCache[] = [];
      for (const rule of rules.filter((r) => r.when === "every_sweep" || due)) {
        const pruned = await apply(rule);
        if (pruned) {
          done.push(pruned);
        }
      }

      if (done.length > 0) {
        const freed = done.reduce((sum, s) => sum + s.freed, 0);
        log.info(
          `pruned the caches: ${humanSize(freed)} reclaimed (${done.map((s) => `${s.cache} ${humanSize(s.freed)}`).join(", ")})`,
        );
      }

      return done;
    },
  };
}

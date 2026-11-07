import { join } from "node:path";
import { silentLogger } from "@outstaff/core";
import { WARN_AT, volumeUsage } from "#/doctor/disk.js";
import { cacheDirs, humanSize, measureFolders } from "#/home/index.js";
import { lastLine, runProgram } from "#/tools/mise.js";
import { removeOlderThan } from "./old-files.js";
import type { CachePruner, CachePrunerOptions, PrunedCache } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** npm cache entries not written for this long go when the home is short of space. */
const NPM_UNUSED_DAYS = 30;

/** pnpm and npm walk large stores; give them time, but not forever. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Prunes the tool and package caches of the agent's home, by what each costs to rebuild. Every sweep clears mise's
 * cache (download archives of tools already installed, which installed tools never read again). Only while the home
 * volume is over the doctor's warning share: `pnpm store prune` (packages no project on disk links to), and npm cache
 * entries not written for 30 days, then `npm cache verify` to drop the content nothing refers to. A tool that is not
 * installed is skipped quietly.
 */
export function createCachePruner(opts: CachePrunerOptions): CachePruner {
  const run = opts.run ?? runProgram;
  const volume = opts.volume ?? volumeUsage;
  const measure = opts.measure ?? measureFolders;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? silentLogger;
  const dirs = cacheDirs(opts.home, opts.env);

  const size = async (path: string) => (await measure([{ name: path, path }]))[0]?.bytes ?? 0;

  /** Runs one tool's step and measures what it freed; undefined when the tool is not installed. */
  async function step(
    name: string,
    path: string,
    file: string,
    args: string[],
    before?: () => Promise<void>,
  ): Promise<PrunedCache | undefined> {
    const at = { cwd: opts.home, env: opts.env, timeoutMs: STEP_TIMEOUT_MS };
    if ((await run(file, ["--version"], at)).code === 127) {
      return undefined;
    }

    const was = await size(path);
    await before?.();
    const r = await run(file, args, at);
    if (r.code !== 0) {
      log.warn("could not prune a cache", { cache: name, error: lastLine(r) });
    }

    return { cache: name, freed: Math.max(0, was - (await size(path))) };
  }

  const overWarning = async () => {
    const u = await volume(opts.home).catch(() => undefined);
    return u !== undefined && u.total > 0 && u.used / u.total >= WARN_AT;
  };

  const npmOld = async () => {
    await removeOlderThan(
      join(dirs.npmCache, "_cacache/index-v5"),
      now() - NPM_UNUSED_DAYS * DAY_MS,
    );
  };

  return {
    async prune() {
      const steps = [await step("mise", dirs.miseCache, "mise", ["cache", "clear"])];
      if (await overWarning()) {
        steps.push(
          await step("pnpm", dirs.pnpmStore, "pnpm", ["store", "prune"]),
          await step("npm", dirs.npmCache, "npm", ["cache", "verify"], npmOld),
        );
      }

      const done = steps.filter((s): s is PrunedCache => s !== undefined);
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

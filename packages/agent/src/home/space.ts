import { cacheDirs, humanSize } from "./folders.js";
import { measureFolders } from "./measure.js";
import type { HomeFolder, HomeSpace, HomeSpaceOptions, MeasuredFolder } from "./types.js";

const IDLE_STATES = new Set(["blocked", "waiting"]);

/** How many items have a workspace, and how many of them are blocked or waiting; empty when the office can't say. */
async function itemCounts(opts: HomeSpaceOptions): Promise<string> {
  const ids = opts.held();
  if (ids.length === 0) {
    return "";
  }

  const states = await opts.workStatus(ids).catch(() => undefined);
  if (!states) {
    return ` (${ids.length} items)`;
  }

  const idle = states.filter((s) => IDLE_STATES.has(s.state)).length;
  return ` (${ids.length} items, ${idle} blocked or waiting)`;
}

const sizeOf = (f: MeasuredFolder) => `${f.capped ? "over " : ""}${humanSize(f.bytes)}`;

/** The folders of the agent's home that fill its volume, measured on demand. */
export function createHomeSpace(opts: HomeSpaceOptions): HomeSpace {
  const measure = opts.measure ?? measureFolders;

  const folders = (): HomeFolder[] => {
    const dirs = cacheDirs(opts.home, opts.env);
    return [
      { name: "pnpm store", path: dirs.pnpmStore },
      { name: "mise tools", path: dirs.miseData },
      { name: "mise cache", path: dirs.miseCache },
      { name: "pnpm cache", path: dirs.pnpmCache },
      { name: "npm cache", path: dirs.npmCache },
      { name: "worktrees", path: opts.worktreesDir },
    ];
  };

  return {
    folders,

    async breakdown() {
      const measured = (await measure(folders()))
        .filter((f) => f.bytes > 0)
        .toSorted((a, b) => b.bytes - a.bytes);

      if (measured.length === 0) {
        return undefined;
      }

      const counts = measured.some((f) => f.name === "worktrees") ? await itemCounts(opts) : "";
      const parts = measured.map(
        (f) => `${f.name} ${sizeOf(f)}${f.name === "worktrees" ? counts : ""}`,
      );

      return `Largest in the home: ${parts.join(", ")}.`;
    },
  };
}

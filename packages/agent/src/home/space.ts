import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { cacheHome, dataHome, humanSize } from "./folders.js";
import { measureFolders } from "./measure.js";
import type { HomeFolder, HomeSpace, HomeSpaceOptions, MeasuredFolder } from "./types.js";

const IDLE_STATES = new Set(["blocked", "waiting"]);

/** How many of the largest folders the breakdown names. */
export const LARGEST = 5;

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

/** The entries of a folder, each with whether it is a real folder (not a link to one); none when it can't be read. */
const entriesOf = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => [])).map((e) => ({
    path: join(dir, e.name),
    dir: e.isDirectory(),
  }));

/** Whether `path` is `inner` or a folder that holds it. */
const holds = (path: string, inner: string) => inner === path || inner.startsWith(path + sep);

/**
 * The folders of the agent's home that fill its volume, measured on demand. No tool is named: the breakdown measures
 * what is there, the home's own entries, with the cache and data homes (`~/.cache` and `~/.local/share`, or their
 * `XDG_*` overrides) split into their entries, so each tool's cache or data folder is one entry.
 */
export function createHomeSpace(opts: HomeSpaceOptions): HomeSpace {
  const measure = opts.measure ?? measureFolders;
  const { home, worktreesDir } = opts;
  const name = (path: string) =>
    path === worktreesDir ? "worktrees" : holds(home, path) ? `~/${relative(home, path)}` : path;

  /** The entries of `dir`, a folder that holds one of `split` replaced by its own entries, and so on down. */
  async function below(dir: string, split: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const e of await entriesOf(dir)) {
      if (e.dir && split.some((s) => holds(e.path, s) && e.path !== s)) {
        found.push(...(await below(e.path, split)));
      } else if (e.dir && split.includes(e.path)) {
        found.push(...(await entriesOf(e.path)).map((x) => x.path));
      } else {
        found.push(e.path);
      }
    }

    return found;
  }

  async function folders(): Promise<HomeFolder[]> {
    const split = [cacheHome(home, opts.env), dataHome(home, opts.env)];
    const outside = split.filter((s) => !holds(home, s));
    const paths = [
      ...(
        await Promise.all(outside.map(async (s) => (await entriesOf(s)).map((e) => e.path)))
      ).flat(),
      ...(await below(
        home,
        split.filter((s) => holds(home, s)),
      )),
    ];

    // A store before the worktrees that link into it: a file hard-linked into both counts in the store.
    const ordered = [
      ...paths.filter((p) => split.some((s) => holds(s, p))),
      ...paths.filter((p) => !split.some((s) => holds(s, p)) && p !== worktreesDir),
      ...(paths.includes(worktreesDir) ? [worktreesDir] : []),
    ];

    return ordered.map((path) => ({ name: name(path), path }));
  }

  return {
    folders,

    async breakdown() {
      const measured = (await measure(await folders()))
        .filter((f) => f.bytes > 0)
        .toSorted((a, b) => b.bytes - a.bytes)
        .slice(0, LARGEST);

      if (measured.length === 0) {
        return undefined;
      }

      const counts = measured.some((f) => f.path === worktreesDir) ? await itemCounts(opts) : "";
      const parts = measured.map(
        (f) => `${f.name} ${sizeOf(f)}${f.path === worktreesDir ? counts : ""}`,
      );

      return `Largest in the home: ${parts.join(", ")}.`;
    },
  };
}

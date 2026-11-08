import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HomeFolder, MeasuredFolder } from "./types.js";

/** Most entries one measuring pass looks at, over all folders, so a doctor check stays cheap. */
export const MAX_ENTRIES = 2_000_000;

const entriesOf = (dir: string): Promise<Dirent[]> =>
  readdir(dir, { withFileTypes: true }).catch(() => []);

/**
 * The space an entry takes on disk, once per inode (zero when it was counted already or is gone), and whether it is a
 * folder to go into: a link to one is not.
 */
async function sizeOnce(path: string, seen: Set<string>) {
  const s = await lstat(path).catch(() => undefined);
  if (!s) {
    return { bytes: 0, dir: false };
  }

  const key = `${s.dev}:${s.ino}`;
  const bytes = seen.has(key) ? 0 : s.blocks * 512;
  seen.add(key);
  return { bytes, dir: s.isDirectory() };
}

/** One folder's walk, from the entries left; resolves to its size and whether it was cut short. */
async function walk(path: string, seen: Set<string>, budget: { left: number }) {
  let bytes = 0;
  const stack = [path];
  while (stack.length > 0 && budget.left > 0) {
    const dir = stack.pop()!;
    const own = await sizeOnce(dir, seen);
    bytes += own.bytes;
    if (!own.dir) {
      continue;
    }

    const entries = await entriesOf(dir);
    budget.left -= entries.length;
    stack.push(...entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name)));
    for (const e of entries.filter((x) => !x.isDirectory())) {
      bytes += (await sizeOnce(join(dir, e.name), seen)).bytes;
    }
  }

  return { bytes, capped: stack.length > 0 };
}

/**
 * Measures the folders in one walk, like `du`: symbolic links are not followed, and a file hard-linked into several
 * folders (pnpm links its store into each `node_modules`) counts once, in the first folder that has it. A missing
 * folder is 0, and a file or link is its own size. The walk stops after about `maxEntries` entries in all; the folders
 * it did not finish are `capped`.
 */
export async function measureFolders(
  folders: HomeFolder[],
  maxEntries = MAX_ENTRIES,
): Promise<MeasuredFolder[]> {
  const seen = new Set<string>();
  const budget = { left: maxEntries };
  const measured: MeasuredFolder[] = [];
  for (const folder of folders) {
    measured.push({ ...folder, ...(await walk(folder.path, seen, budget)) });
  }

  return measured;
}

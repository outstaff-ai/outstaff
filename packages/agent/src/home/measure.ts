import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HomeFolder, MeasuredFolder } from "./types.js";

/** Most entries one measuring pass looks at, over all folders, so a doctor check stays cheap. */
export const MAX_ENTRIES = 2_000_000;

const entriesOf = (dir: string): Promise<Dirent[]> =>
  readdir(dir, { withFileTypes: true }).catch(() => []);

/** The space a file takes on disk, once per inode; zero when it was counted already or is gone. */
async function sizeOnce(path: string, seen: Set<string>): Promise<number> {
  const s = await lstat(path).catch(() => undefined);
  if (!s) {
    return 0;
  }

  const key = `${s.dev}:${s.ino}`;
  if (seen.has(key)) {
    return 0;
  }

  seen.add(key);
  return s.blocks * 512;
}

/**
 * Measures the folders in one walk, like `du`: symbolic links are not followed, and a file hard-linked into several
 * folders (pnpm links its store into each `node_modules`) counts once, in the first folder that has it. A missing
 * folder is 0. The walk stops after `maxEntries` entries in all; the folders it did not finish are `capped`.
 */
export async function measureFolders(
  folders: HomeFolder[],
  maxEntries = MAX_ENTRIES,
): Promise<MeasuredFolder[]> {
  const seen = new Set<string>();
  let left = maxEntries;
  const measured: MeasuredFolder[] = [];
  for (const folder of folders) {
    let bytes = 0;
    const stack = [folder.path];
    while (stack.length > 0 && left > 0) {
      const dir = stack.pop()!;
      bytes += await sizeOnce(dir, seen);
      for (const e of await entriesOf(dir)) {
        left -= 1;
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(path);
        } else {
          bytes += await sizeOnce(path, seen);
        }
      }
    }

    measured.push({ ...folder, bytes, capped: stack.length > 0 });
  }

  return measured;
}

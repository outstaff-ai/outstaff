import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Removes the files below `dir` last written before `cutoff` (epoch ms). Resolves to how many it removed. */
export async function removeOlderThan(dir: string, cutoff: number): Promise<number> {
  let removed = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop()!;
    for (const e of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, e.name);
      if (e.isDirectory()) {
        stack.push(path);
        continue;
      }

      const s = await stat(path).catch(() => undefined);
      if (s && s.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
  }

  return removed;
}

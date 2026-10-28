import type { MemoryRepo, Mergeability } from "./types.js";

/**
 * A repository without git: every branch exists and gets a made-up commit on first sight, a push gives it a new
 * one, and mergeability follows a script per branch (the last answer sticks). Merging changes nothing.
 */
export function createMemoryRepo(): MemoryRepo {
  const heads = new Map<string, string>();
  const scripts = new Map<string, Mergeability[]>();
  let minted = 0;
  const mint = () => (++minted).toString(16).padStart(40, "0");
  const commit = (ref: string, sha = mint()) => {
    heads.set(ref, sha);
    return sha;
  };

  return {
    sha: async (ref) => heads.get(ref) ?? commit(ref),
    async mergeable(_base, head) {
      const script = scripts.get(head);
      if (!script) {
        return "clean";
      }

      return (script.length > 1 ? script.shift() : script[0]) ?? "unknown";
    },
    conflicts: async (_base, head) => scripts.get(head)?.[0] === "conflicting",
    merge: async () => undefined,
    diff: async (_base, head) =>
      `diff --git a/${head}.txt b/${head}.txt\n--- a/${head}.txt\n+++ b/${head}.txt\n@@ -1 +1 @@\n-old\n+new\n`,
    isAncestor: async () => true,
    ahead: async () => 1,
    branches: async () => Object.fromEntries(heads),
    commit,
    script: (ref, answers) => void scripts.set(ref, [...answers]),
  };
}

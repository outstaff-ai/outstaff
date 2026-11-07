import type { MemoryRepo, Mergeability } from "./types.js";

/**
 * A repository without git: every branch exists and gets a made-up commit on first sight, a push gives it a new
 * one on top of the old, and mergeability follows a script per branch (the last answer sticks). A merge makes a merge
 * commit and moves the base onto it. A commit it did not make is taken to be in every history.
 */
export function createMemoryRepo(): MemoryRepo {
  const heads = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const scripts = new Map<string, Mergeability[]>();
  let minted = 0;
  const mint = () => (++minted).toString(16).padStart(40, "0");
  const land = (ref: string, sha: string, of: string[]) => {
    parents.set(sha, of);
    heads.set(ref, sha);
    return sha;
  };

  const commit = (ref: string, sha = mint()) => {
    const prev = heads.get(ref);
    return land(ref, sha, prev && prev !== sha ? [prev] : (parents.get(sha) ?? []));
  };

  const resolve = (ref: string) => heads.get(ref) ?? ref;

  /** Whether `ancestor` is `sha` or one of its parents' history. */
  const reaches = (sha: string, ancestor: string): boolean =>
    sha === ancestor || (parents.get(sha) ?? []).some((p) => reaches(p, ancestor));

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
    merge: async (base, head) =>
      land(base, mint(), [...(heads.has(base) ? [heads.get(base)!] : []), resolve(head)]),
    diff: async (_base, head) =>
      `diff --git a/${head}.txt b/${head}.txt\n--- a/${head}.txt\n+++ b/${head}.txt\n@@ -1 +1 @@\n-old\n+new\n`,
    async isAncestor(ancestor, descendant) {
      const [a, d] = [resolve(ancestor), resolve(descendant)];
      return !parents.has(a) || !parents.has(d) || reaches(d, a);
    },
    ahead: async () => 1,
    branches: async () => Object.fromEntries(heads),
    commit,
    script: (ref, answers) => void scripts.set(ref, [...answers]),
  };
}

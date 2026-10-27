import { posix } from "node:path";
import type { PathRules, PathVerdict } from "./types.js";

const cache = new Map<string, RegExp>();

/** `**` crosses directories, `*` and `?` do not. `dir/**` also matches `dir` itself. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) {
    return hit;
  }

  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      const star = starPattern(glob, i);
      re += star.re;
      i += star.skip;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  re = re.replace(/\/\.\*$/, "(?:/.*)?");
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

/** The pattern of the `**\/`, `**` or `*` at `i`, and how many characters past `i` it spans. */
function starPattern(glob: string, i: number): { re: string; skip: number } {
  if (glob[i + 1] !== "*") {
    return { re: "[^/]*", skip: 0 };
  }

  return glob[i + 2] === "/" ? { re: "(?:.*/)?", skip: 2 } : { re: ".*", skip: 1 };
}

export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function resolvePath(p: string, cwd: string, home: string): string {
  let q = p;
  if (q === "~") {
    q = home;
  } else if (q.startsWith("~/")) {
    q = posix.join(home, q.slice(2));
  }

  if (!posix.isAbsolute(q)) {
    q = posix.join(cwd, q);
  }

  const n = posix.normalize(q);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

export function judgePath(rules: PathRules, abs: string): PathVerdict {
  if (matchesAny(rules.deny, abs)) {
    return "denied";
  }

  return matchesAny(rules.allow, abs) ? "allow" : "outside";
}

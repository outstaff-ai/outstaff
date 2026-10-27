import { execFileSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import type { SecretsLocation } from "#/types.js";

/** git's own answer, so every ignore rule and nesting is honoured. Not a repository: nothing can be committed, so nothing to check. */
function isIgnored(dir: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: dir, stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== 1;
  }
}

function inRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The ignore rules that are missing, as lines for `.gitignore`. */
export function missingIgnores(out: string, envFile: string, secrets: SecretsLocation): string[] {
  if (!inRepo(out)) {
    return [];
  }

  const missing: string[] = [];
  if (!isIgnored(out, envFile.replaceAll("\\", "/"))) {
    missing.push(".outstaff/**/.env");
  }

  const inside = (dir: string): string | undefined => {
    const rel = relative(out, dir);
    return rel.startsWith("..") || isAbsolute(rel) || rel === ""
      ? undefined
      : rel.replaceAll("\\", "/");
  };

  const file = inside(secrets.dir);
  const rule = inside(secrets.ignoreDir);
  if (file && rule && !isIgnored(out, `${file}/KEY`)) {
    missing.push(`${rule}/`);
  }

  return missing;
}

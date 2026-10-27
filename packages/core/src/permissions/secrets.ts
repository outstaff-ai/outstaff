import { deny } from "./decision.js";
import { globToRegExp, judgePath, resolvePath } from "./paths.js";
import type { Decision, Policy } from "./types.js";

/** Whether `abs` is the secrets folder or one of its parents, so that reading it recursively reads the secrets. */
/**
 * Whether reading `abs` recursively reads secrets: the secrets folder or one of its parents, or `/proc`, which holds
 * every process's environment.
 */
export const holdsSecrets = (policy: Policy, abs: string): boolean =>
  abs === policy.secretsDir ||
  policy.secretsDir.startsWith(abs === "/" ? "/" : `${abs}/`) ||
  abs === "/proc" ||
  abs.startsWith("/proc/");

/** File names a pattern must not reach: the names the credential globs deny wherever they are. */
const SECRET_NAMES = [
  ".env",
  ".env.local",
  "key.pem",
  ".netrc",
  ".git-credentials",
  ".credentials.json",
  "id_rsa",
];

/**
 * Whether a shell pattern such as `/work/secre*` or `/proc/self/env*` could expand to a credential: it lies under
 * `/proc`, a prefix of it matches the secrets folder, or its last part is aimed at a credential file name.
 */
function patternReachesSecrets(policy: Policy, abs: string): boolean {
  if (abs === "/proc" || abs.startsWith("/proc/")) {
    return true;
  }

  const parts = abs.split("/");
  for (let i = 2; i <= parts.length; i++) {
    if (globToRegExp(parts.slice(0, i).join("/")).test(policy.secretsDir)) {
      return true;
    }
  }

  // As in the shell, a pattern reaches a dot file only when its last part starts with a dot. A pattern that matches
  // any name (`build/*`) says nothing about credentials; one aimed at them (`*.pem`, `.en?`) does.
  const dir = parts.slice(0, -1).join("/");
  const dotted = parts.at(-1)!.startsWith(".");
  const pattern = globToRegExp(abs);
  if (pattern.test(`${dir}/${dotted ? "." : ""}plain-name`)) {
    return false;
  }

  return SECRET_NAMES.filter((name) => dotted || !name.startsWith(".")).some((name) => {
    const path = `${dir}/${name}`;
    return pattern.test(path) && judgePath(policy.paths.read, path) === "denied";
  });
}

/** Whether the text names the secrets folder as a path (followed by nothing, a slash, a quote or a space). */
export function namesSecretsDir(policy: Policy, text: string): boolean {
  const dir = policy.secretsDir.replace(/\/+$/, "");
  let at = text.indexOf(dir);
  while (at >= 0) {
    const next = text[at + dir.length];
    if (next === undefined || /[/\s"'`;|&)]/.test(next)) {
      return true;
    }

    at = text.indexOf(dir, at + 1);
  }

  return false;
}

/** A word that names a credential file: the word itself, the value of `--opt=value` and an `@file` argument. */
export function secretWord(policy: Policy, word: string, cwd: string): Decision | undefined {
  for (const path of wordPaths(word)) {
    const denied = secretPath(policy, path, cwd);
    if (denied) {
      return denied;
    }
  }

  return undefined;
}

/** The paths a word may name: itself, the value of `--opt=value` and the file of `@file`; never an option or a URL. */
function wordPaths(word: string): string[] {
  const candidates = [word];
  const eq = word.indexOf("=");
  if (eq > 0) {
    candidates.push(word.slice(eq + 1));
  }

  if (word.startsWith("@")) {
    candidates.push(word.slice(1));
  }

  return candidates.filter(
    (c) => c !== "" && !c.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(c),
  );
}

function secretPath(policy: Policy, path: string, cwd: string): Decision | undefined {
  const abs = resolvePath(path, cwd, policy.home);
  if (judgePath(policy.paths.read, abs) === "denied") {
    return deny(`${abs} holds credentials; it is off limits.`, "paths.read.deny");
  }

  if (/[*?[]/.test(path) && patternReachesSecrets(policy, abs)) {
    return deny(`The pattern ${abs} could expand to credentials.`, "paths.read.deny");
  }
}

const printsAll = (args: string[]) => args.every((a) => a.startsWith("-"));

/** Programs that print the environment, each with whether these arguments make it do so. */
const ENV_PRINTERS = new Map<string, (args: string[]) => boolean>([
  ["printenv", () => true],
  ["export", (args) => args.every((a) => a === "-p")],
  ["declare", printsAll],
  ["typeset", printsAll],
  ["set", (args) => args.length === 0],
  // BSD-style `e` (and `-E` on macOS) adds each process's environment to the listing.
  [
    "ps",
    (args) =>
      /^[a-zA-Z]*e[a-zA-Z]*$/.test(args[0] ?? "") || args.some((a) => /^-[a-zA-Z]*E/.test(a)),
  ],
]);

export function envPrinting(program: string, args: string[]): Decision | undefined {
  if (ENV_PRINTERS.get(program)?.(args)) {
    return deny("Printing the environment is denied: it holds credentials.", "secrets.environment");
  }
}

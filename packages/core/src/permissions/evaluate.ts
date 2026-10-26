import { adbCommand, adbDestructive, fastbootDestructive } from "./adb.js";
import { evaluateGit, repoFor } from "./git.js";
import { globToRegExp, judgePath, resolvePath } from "./paths.js";
import { lex, type Segment } from "./shell.js";
import type { ArgPredicate, CommandRule, Decision, Policy, ToolCall } from "./types.js";

const allow = (reason: string, rule?: string): Decision => ({
  effect: "allow",
  reason,
  ...(rule ? { rule } : {}),
});

const deny = (reason: string, rule?: string): Decision => ({
  effect: "deny",
  reason,
  ...(rule ? { rule } : {}),
});

const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const MAX_CWDS = 8;
const MAX_DEPTH = 6;

/** Where the shell is after a `cd` the policy cannot follow (`cd -`, `cd $DIR`, `popd`). No repository lies there. */
const UNKNOWN_CWD = "/(unknown directory)";

/** Variables whose value is a credential by name. Expanding one could print it. */
const SECRET_VAR = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;

/** Programs that read whole directory trees; pointing one at a parent of the secrets folder reads the secrets. */
const TREE_READERS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "tar",
  "zip",
  "cp",
  "rsync",
  "scp",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);

/** Words that start a shell construct and come before the command they guard. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "{", "}"]);

/**
 * Programs that run the command after their own options. `valued` options take a value; `skip` is the number of
 * positional arguments before the command (the duration of `timeout`, the lock file of `flock`).
 */
const WRAPPERS: Record<string, { valued?: string[]; skip?: number }> = {
  nohup: {},
  time: { valued: ["-f", "-o"] },
  command: {},
  builtin: {},
  exec: { valued: ["-a"] },
  nice: { valued: ["-n"] },
  timeout: { valued: ["-s", "-k", "--signal", "--kill-after"], skip: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  ionice: { valued: ["-c", "-n", "-p"] },
  setsid: {},
  chrt: { skip: 1 },
  taskset: { skip: 1 },
  flock: { valued: ["-w", "-E"], skip: 1 },
  watch: { valued: ["-n", "-d", "--interval"] },
  unbuffer: {},
  xargs: {
    valued: [
      "-I",
      "-i",
      "-n",
      "-P",
      "-d",
      "-L",
      "-l",
      "-s",
      "-a",
      "-E",
      "-e",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--arg-file",
      "--replace",
    ],
  },
};

const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

const isDynamic = (word: string): boolean => /[$`]/.test(word);

function checkPath(policy: Policy, access: "read" | "write", raw: string, cwd: string): Decision {
  const abs = resolvePath(raw, cwd, policy.home);
  if (access === "write" && SINKS.has(abs)) {
    return allow("Discarding output.", "paths.write.sink");
  }

  const verdict = judgePath(policy.paths[access], abs);
  if (verdict === "denied") {
    return deny(`${abs} is off limits.`, `paths.${access}.deny`);
  }

  if (verdict === "outside") {
    return deny(
      `${abs} is outside the paths this person may ${access} with the ${access === "write" ? "edit" : "read"} tools.`,
      `paths.${access}.outside`,
    );
  }

  return allow(`${abs} is ${access}able.`, `paths.${access}.allow`);
}

/** Whether `abs` is the secrets folder or one of its parents, so that reading it recursively reads the secrets. */
/**
 * Whether reading `abs` recursively reads secrets: the secrets folder or one of its parents, or `/proc`, which holds
 * every process's environment.
 */
const holdsSecrets = (policy: Policy, abs: string): boolean =>
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
function namesSecretsDir(policy: Policy, text: string): boolean {
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

/** Worst of: deny, allow. */
function worst(decisions: Decision[]): Decision {
  return (
    decisions.find((d) => d.effect === "deny") ??
    decisions[decisions.length - 1] ??
    allow("Nothing to check.")
  );
}

function flagValues(args: string[], names: string[]): string[] | null {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) {
        found.push(args[i + 1] ?? "");
      } else if (name.startsWith("--") && a.startsWith(`${name}=`)) {
        found.push(a.slice(name.length + 1));
      } else if (
        !name.startsWith("--") &&
        a.startsWith(name) &&
        !a.startsWith("--") &&
        a.length > name.length
      ) {
        found.push(a.slice(name.length).replace(/^=/, ""));
      }
    }
  }

  return found.length === 0 ? null : found;
}

function predicateHolds(p: ArgPredicate, args: string[], positionals: string[]): boolean {
  switch (p.kind) {
    case "flag":
      return (flagValues(args, p.names) !== null) === p.present;
    case "flag-value": {
      const values = flagValues(args, p.names);
      if (values === null) {
        return false;
      }

      const set = new Set(p.values.map((v) => v.toLowerCase()));
      const hit = values.some((v) => set.has(v.toLowerCase()));
      return p.match === "in" ? hit : values.some((v) => !set.has(v.toLowerCase()));
    }

    case "positional": {
      const v = positionals[p.index];
      return v !== undefined && new RegExp(p.pattern, "i").test(v);
    }
  }
}

function matchRule(
  r: CommandRule,
  program: string,
  args: string[],
): { positionals: string[] } | null {
  if (r.program !== program) {
    return null;
  }

  const all: string[] = [];
  let afterDashes = false;
  for (const a of args) {
    if (a === "--" && !afterDashes) {
      afterDashes = true;
    } else if (afterDashes || !a.startsWith("-")) {
      all.push(a);
    }
  }

  const sub = r.subcommand ?? [];
  if (sub.some((w, i) => all[i] !== w)) {
    return null;
  }

  const positionals = all.slice(sub.length);
  if (!(r.args ?? []).every((p) => predicateHolds(p, args, positionals))) {
    return null;
  }

  return { positionals };
}

/**
 * Deny rules win. A program no allow rule names runs (built-in fallback denies still apply to it); a program that allow
 * rules name runs only what one of them allows.
 */
function evaluateCommandRules(
  policy: Policy,
  program: string,
  args: string[],
  cwd: string,
): Decision {
  const named = policy.commands.filter((r) => r.program === program);
  const matches = named.map((r) => ({ r, m: matchRule(r, program, args) })).filter((x) => x.m);

  const denied = matches.find((x) => x.r.effect === "deny" && !x.r.fallback);
  if (denied) {
    return deny(denied.r.reason, denied.r.id);
  }

  const narrowed = named.some((r) => r.effect === "allow");
  if (!narrowed) {
    const fallback = matches.find((x) => x.r.effect === "deny");
    return fallback
      ? deny(fallback.r.reason, fallback.r.id)
      : allow(`${program} runs inside the sandbox.`, "commands.default");
  }

  const hit = matches.find((x) => x.r.effect === "allow");
  if (!hit) {
    return deny(
      `${program} is limited to the commands its tools declaration or team rules allow, and this is not one of them.`,
      "commands.narrowed",
    );
  }

  const { r, m } = hit;
  if (r.requiresRepo) {
    if (flagValues(args, ["-R", "--repo"]) !== null) {
      return deny(
        "A -R/--repo target cannot be mapped to a granted repository.",
        "commands.repo-flag",
      );
    }

    const repo = repoFor(policy, cwd);
    if (!repo) {
      return deny(`${program} ran outside the granted repositories.`, "git.no-repo");
    }

    if (r.requiresRepo === "write" && repo.mode !== "write") {
      return deny("This repository is read-only for this person.", "git.read-only-repo");
    }
  }

  if (r.pathArgs) {
    for (const raw of m!.positionals) {
      const d = checkPath(policy, r.pathArgs, raw, cwd);
      if (d.effect !== "allow") {
        return d;
      }
    }
  }

  return allow(r.reason, r.id);
}

/** A word that names a credential file: the word itself, the value of `--opt=value` and an `@file` argument. */
function secretWord(policy: Policy, word: string, cwd: string): Decision | undefined {
  const candidates = [word];
  const eq = word.indexOf("=");
  if (eq > 0) {
    candidates.push(word.slice(eq + 1));
  }

  if (word.startsWith("@")) {
    candidates.push(word.slice(1));
  }

  for (const c of candidates) {
    if (c === "" || c.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(c)) {
      continue;
    }

    const abs = resolvePath(c, cwd, policy.home);
    if (judgePath(policy.paths.read, abs) === "denied") {
      return deny(`${abs} holds credentials; it is off limits.`, "paths.read.deny");
    }

    if (/[*?[]/.test(c) && patternReachesSecrets(policy, abs)) {
      return deny(`The pattern ${abs} could expand to credentials.`, "paths.read.deny");
    }
  }

  return undefined;
}

function envPrinting(program: string, args: string[]): Decision | undefined {
  const printing = deny(
    "Printing the environment is denied: it holds credentials.",
    "secrets.environment",
  );

  switch (program) {
    case "printenv":
      return printing;
    case "export":
      return args.every((a) => a === "-p") ? printing : undefined;
    case "declare":
    case "typeset":
      return args.every((a) => a.startsWith("-")) ? printing : undefined;
    case "set":
      return args.length === 0 ? printing : undefined;
    case "ps":
      // BSD-style `e` (and `-E` on macOS) adds each process's environment to the listing.
      return /^[a-zA-Z]*e[a-zA-Z]*$/.test(args[0] ?? "") || args.some((a) => /^-[a-zA-Z]*E/.test(a))
        ? printing
        : undefined;
    default:
      return undefined;
  }
}

/** The command `env` runs, or null when it runs none and so prints the environment. */
function envCommand(args: string[]): { words: string[] } | { script: string } | null {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      i++;
      break;
    }

    if (a === "-u" || a === "-C" || a === "--unset" || a === "--chdir") {
      i++;
    } else if (a === "-S" || a === "--split-string") {
      return { script: args.slice(i + 1).join(" ") };
    } else if (a.startsWith("--split-string=")) {
      return { script: [a.slice(15), ...args.slice(i + 1)].join(" ") };
    } else if (!a.startsWith("-")) {
      break;
    }
  }

  while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]!)) {
    i++;
  }

  return i < args.length ? { words: args.slice(i) } : null;
}

/** The command a wrapper runs after its own options, or an empty list when it runs none. */
function wrapped(spec: { valued?: string[]; skip?: number }, args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") {
    const a = args[i]!;
    i += spec.valued?.includes(a) ? 2 : 1;
  }

  if (args[i] === "--") {
    i++;
  }

  return args.slice(i + (spec.skip ?? 0));
}

/** The commands `find -exec` and its kin run, without the `{}` placeholder. */
function findCommands(args: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!)) {
      const end = args.findIndex((a, j) => j > i && (a === ";" || a === "+"));
      out.push(args.slice(i + 1, end < 0 ? args.length : end));
      i = end < 0 ? args.length : end;
    }
  }

  return out;
}

/** Programs that write their last path argument from the others. */
const COPIERS = new Set(["cp", "ln", "install", "rsync"]);

/** Programs whose path arguments they write, move or remove. */
const WRITERS = new Set([
  "mv",
  "rm",
  "tee",
  "touch",
  "truncate",
  "chmod",
  "mkdir",
  "rmdir",
  "unlink",
]);

/**
 * The paths a command writes, as far as its words say: the path arguments of a writing program (`cp`, `tee`,
 * `sed -i`, ...) and `of=` of `dd`. Wrappers are not followed; redirections are judged on their own.
 */
function writeTargets(input: string[]): string[] {
  const words = input.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith("of="));
  const program = base(words[0] ?? "");
  const args = words.slice(1);
  const paths = (list: string[]) => list.filter((a) => a !== "" && !a.startsWith("-"));
  if (COPIERS.has(program)) {
    // The sources are read; only the destination is written.
    return paths(args).slice(-1);
  }

  if (WRITERS.has(program)) {
    return paths(args);
  }

  if (
    (program === "sed" || program === "perl") &&
    args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))
  ) {
    return paths(args);
  }

  if (program === "dd") {
    return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  }

  return [];
}

interface Ctx {
  policy: Policy;
  call: ToolCall;
  depth: number;
}

/** Judges one command: its words after redirections are taken off. */
function judgeCommand(ctx: Ctx, input: string[], cwd: string): Decision {
  let words = input;
  while (
    words.length > 0 &&
    (KEYWORDS.has(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[0]!))
  ) {
    words = words.slice(1);
  }

  if (words.length === 0) {
    return allow("No command.");
  }

  if (ctx.depth > MAX_DEPTH) {
    return deny("Commands nested this deeply cannot be judged.", "shell.depth");
  }

  const { policy } = ctx;
  const program = base(words[0]!);
  const args = words.slice(1);
  if (isDynamic(words[0]!)) {
    return allow(
      "The program is chosen at run time; it runs inside the sandbox.",
      "commands.default",
    );
  }

  const inner = (w: string[]) => judgeCommand({ ...ctx, depth: ctx.depth + 1 }, w, cwd);
  const script = (text: string) => judgeLine({ ...ctx, depth: ctx.depth + 1 }, text, [cwd]);
  const checks: Decision[] = [evaluateCommandRules(policy, program, args, cwd)];

  const printing = envPrinting(program, args);
  if (printing) {
    return printing;
  }

  if (program === "env") {
    const run = envCommand(args);
    if (run === null) {
      return deny(
        "env without a command prints the environment, which holds credentials.",
        "secrets.environment",
      );
    }

    checks.push("script" in run ? script(run.script) : inner(run.words));
  } else if (SHELLS.has(program)) {
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at >= 0 && args[at + 1] !== undefined) {
      checks.push(script(args[at + 1]!));
    }
  } else if (program === "eval") {
    checks.push(script(args.join(" ")));
  } else if (WRAPPERS[program]) {
    checks.push(inner(wrapped(WRAPPERS[program], args)));
  } else if (program === "find") {
    checks.push(...findCommands(args).map(inner));
  } else if (program === "git") {
    checks.push(evaluateGit(policy, args, cwd, ctx.call));
  } else if (program === "adb") {
    const problem = adbDestructive(adbCommand(args));
    if (problem) {
      checks.push(deny(problem, "adb.destructive"));
    }
  } else if (program === "fastboot") {
    const problem = fastbootDestructive(args);
    if (problem) {
      checks.push(deny(problem, "adb.destructive"));
    }
  }

  if (TREE_READERS.has(program)) {
    for (const a of args) {
      if (!a.startsWith("-") && holdsSecrets(policy, resolvePath(a, cwd, policy.home))) {
        checks.push(deny(`${program} ${a} would read the secrets folder.`, "paths.read.deny"));
      }
    }
  }

  // A git push further along the line (`npx something git push ...`) is judged as a push.
  for (let k = 1; k < words.length; k++) {
    if (base(words[k]!) === "git" && words.slice(k + 1).includes("push") && program !== "git") {
      const d = evaluateGit(policy, words.slice(k + 1), cwd, ctx.call);
      if (d.effect === "deny") {
        checks.push(d);
      }
    }
  }

  return worst(checks);
}

function evaluateSegment(ctx: Ctx, seg: Segment, cwd: string): Decision {
  const { policy } = ctx;
  const checks: Decision[] = [];
  for (const rd of seg.redirects) {
    if (rd.op === "<<<") {
      continue;
    }

    if (rd.op === "<") {
      const d = secretWord(policy, rd.target, cwd);
      if (d) {
        checks.push(d);
      }
    } else {
      const d = checkPath(policy, "write", rd.target, cwd);
      if (d.rule === "paths.write.deny") {
        checks.push(d);
      }
    }
  }

  for (const w of seg.words) {
    const d = secretWord(policy, w, cwd);
    if (d) {
      checks.push(d);
    }
  }

  const written = writeTargets(seg.words);
  for (const target of written) {
    const d = checkPath(policy, "write", target, cwd);
    if (d.rule === "paths.write.deny") {
      checks.push(d);
    }
  }

  const secretVar = seg.vars.find((v) => SECRET_VAR.test(v));
  if (secretVar) {
    checks.push(
      deny(
        `$${secretVar} is a credential by its name; expanding it could print it.`,
        "secrets.variable",
      ),
    );
  }

  for (const sub of seg.subs) {
    checks.push(judgeLine({ ...ctx, depth: ctx.depth + 1 }, sub, [cwd]));
  }

  checks.push(judgeCommand(ctx, seg.words, cwd));
  return worst(checks);
}

/** Where `cd <target>` (or `pushd`) leads from `cwd`; the unknown directory when it cannot be followed. */
function cdTarget(policy: Policy, words: string[], cwd: string): string {
  const target = words.slice(1).find((w) => !w.startsWith("-"));
  if (words[0] === "popd" || target === "-" || (target !== undefined && isDynamic(target))) {
    return UNKNOWN_CWD;
  }

  if (cwd === UNKNOWN_CWD && target !== undefined && !/^[/~]/.test(target)) {
    return UNKNOWN_CWD;
  }

  return resolvePath(target ?? "~", cwd, policy.home);
}

/** Judges a command line from each directory the shell may be in. */
function judgeLine(ctx: Ctx, command: string, start: string[]): Decision {
  const parsed = lex(command);
  if (!parsed.ok) {
    return deny(`Cannot read this command: ${parsed.reason}.`, "shell.unparseable");
  }

  // After a `cd` that is not chained with &&, the shell may still be in the old directory (the cd can fail),
  // so every possible directory is judged and the worst result wins.
  let cwds = start;
  const results: Decision[] = [];
  for (const seg of parsed.segments) {
    for (const cwd of cwds) {
      results.push(evaluateSegment(ctx, seg, cwd));
    }

    const first = seg.words[0];
    const moves = first === "cd" || first === "pushd" || first === "popd";
    const detached = seg.sep === "|" || seg.sep === "&" || seg.before === "|";
    if (moves && !detached) {
      const moved = cwds.map((c) => cdTarget(ctx.policy, seg.words, c));
      cwds = seg.sep === "&&" ? [...new Set(moved)] : [...new Set([...cwds, ...moved])];
      if (cwds.length > MAX_CWDS) {
        return deny("Too many directory changes to track.", "shell.cd");
      }
    }
  }

  return worst(results.length > 0 ? results : [allow("Empty command.")]);
}

function evaluateShell(policy: Policy, call: ToolCall): Decision {
  const command = call.command;
  if (command === undefined || command.trim() === "") {
    return deny("Empty shell command.", "shell.empty");
  }

  // Whatever the shell would make of it, a line that names the secrets folder or a process environment is refused.
  if (namesSecretsDir(policy, command)) {
    return deny("The secrets folder is off limits.", "paths.read.deny");
  }

  if (/\/proc\/[^\s]*environ/.test(command)) {
    return deny(
      "Process environments hold credentials; they are off limits.",
      "secrets.environment",
    );
  }

  const start = resolvePath(call.cwd ?? policy.defaultCwd, policy.defaultCwd, policy.home);
  const final = judgeLine({ policy, call, depth: 0 }, command, [start]);
  return final.effect === "allow" ? allow("Allowed inside the sandbox.", final.rule) : final;
}

/** The reference decision function. Pure: no I/O, no clock. */
export function evaluate(policy: Policy, call: ToolCall): Decision {
  if (policy.tools.deny.includes(call.kind)) {
    return deny(`Tool ${call.kind} is denied.`, "tools.deny");
  }

  if (!policy.tools.allow.includes(call.kind)) {
    return deny(
      `Tool ${call.kind} is not available to the ${policy.profile} profile.`,
      "tools.allow",
    );
  }

  const cwd = resolvePath(call.cwd ?? policy.defaultCwd, policy.defaultCwd, policy.home);
  switch (call.kind) {
    case "read":
    case "write":
    case "edit": {
      if (call.path === undefined) {
        return deny("No path given.", "paths.missing");
      }

      return checkPath(policy, call.kind === "read" ? "read" : "write", call.path, cwd);
    }

    case "search": {
      const abs = resolvePath(call.path ?? cwd, cwd, policy.home);
      if (holdsSecrets(policy, abs)) {
        return deny(`Searching ${abs} would read the secrets folder.`, "paths.read.deny");
      }

      return checkPath(policy, "read", abs, cwd);
    }

    case "shell":
      return evaluateShell(policy, call);
    case "ost":
      if (policy.ost && !policy.ost.allow.includes(call.command ?? "")) {
        return deny(
          `The ost verb ${call.command ?? "(unknown)"} is not available to the ${policy.profile} profile.`,
          "ost.verbs",
        );
      }

      return allow("ost is allowed.", "tools.allow");
    case "artifact": {
      // The tool publishes files from disk, so every source must be readable by the person.
      const sources = [...(call.path === undefined ? [] : [call.path]), ...(call.paths ?? [])];
      const refused = sources
        .map((p) => checkPath(policy, "read", p, cwd))
        .find((d) => d.effect !== "allow");

      return refused ?? allow("artifact is allowed.", "tools.allow");
    }

    case "web_fetch":
    case "subagent":
      return allow(`${call.kind} is allowed.`, "tools.allow");
  }
}

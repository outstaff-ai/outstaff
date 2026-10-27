import { adbCommand, adbDestructive, fastbootDestructive } from "./adb.js";
import { checkPath } from "./check-path.js";
import {
  WRAPPERS,
  base,
  envCommand,
  findCommands,
  isDynamic,
  wrapped,
  writeTargets,
} from "./command-words.js";
import { allow, deny, worst } from "./decision.js";
import { evaluateGit } from "./git.js";
import { resolvePath } from "./paths.js";
import { evaluateCommandRules } from "./rule-match.js";
import { envPrinting, holdsSecrets, namesSecretsDir, secretWord } from "./secrets.js";
import { lex } from "./shell.js";
import type { Segment } from "./shell.types.js";
import type { Decision, Policy, ToolCall } from "./types.js";

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

export function evaluateShell(policy: Policy, call: ToolCall): Decision {
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

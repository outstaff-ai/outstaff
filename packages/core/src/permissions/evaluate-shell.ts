import { checkPath } from "./check-path.js";
import { programChecks } from "./command-programs.js";
import { base, envCommand, isDynamic, writeTargets } from "./command-words.js";
import { allow, deny, worst } from "./decision.js";
import { evaluateGit } from "./git.js";
import { resolvePath } from "./paths.js";
import { evaluateCommandRules } from "./rule-match.js";
import { envPrinting, namesSecretsDir, secretWord } from "./secrets.js";
import { lex } from "./shell.js";
import type { Redirect, Segment } from "./shell.types.js";
import type { CommandScope, Decision, Policy, ToolCall } from "./types.js";

const MAX_CWDS = 8;
const MAX_DEPTH = 6;

/** Where the shell is after a `cd` the policy cannot follow (`cd -`, `cd $DIR`, `popd`). No repository lies there. */
const UNKNOWN_CWD = "/(unknown directory)";

/** Variables whose value is a credential by name. Expanding one could print it. */
const SECRET_VAR = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;

/** Words that start a shell construct and come before the command they guard. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until", "{", "}"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Commands that change the shell's directory. */
const MOVES = new Set(["cd", "pushd", "popd"]);

interface Ctx {
  policy: Policy;
  call: ToolCall;
  depth: number;
}

/** Judges one command: its words after redirections are taken off. */
function judgeCommand(ctx: Ctx, input: string[], cwd: string): Decision {
  const words = commandWords(input);
  if (words.length === 0) {
    return allow("No command.");
  }

  if (ctx.depth > MAX_DEPTH) {
    return deny("Commands nested this deeply cannot be judged.", "shell.depth");
  }

  if (isDynamic(words[0]!)) {
    return allow(
      "The program is chosen at run time; it runs inside the sandbox.",
      "commands.default",
    );
  }

  const program = base(words[0]!);
  const args = words.slice(1);
  const refused = envPrinting(program, args) ?? bareEnv(program, args);
  if (refused) {
    return refused;
  }

  const scope = commandScope(ctx, cwd);

  return worst([
    evaluateCommandRules(ctx.policy, program, args, cwd),
    ...programChecks(program, args, scope),
    ...laterPushes(program, words, scope),
  ]);
}

/** The words from the command on: keywords (`if`, `!`, ...) and variable assignments before it are dropped. */
function commandWords(words: string[]): string[] {
  const at = words.findIndex((w) => !KEYWORDS.has(w) && !ASSIGNMENT.test(w));

  return at < 0 ? [] : words.slice(at);
}

/** `env` without a command prints the environment. */
function bareEnv(program: string, args: string[]): Decision | undefined {
  if (program === "env" && envCommand(args) === null) {
    return deny(
      "env without a command prints the environment, which holds credentials.",
      "secrets.environment",
    );
  }
}

function commandScope(ctx: Ctx, cwd: string): CommandScope {
  const nested = { ...ctx, depth: ctx.depth + 1 };

  return {
    policy: ctx.policy,
    call: ctx.call,
    cwd,
    inner: (words) => judgeCommand(nested, words, cwd),
    script: (text) => judgeLine(nested, text, [cwd]),
  };
}

/** A git push further along the line (`npx something git push ...`) is judged as a push. */
function laterPushes(program: string, words: string[], scope: CommandScope): Decision[] {
  if (program === "git") {
    return [];
  }

  return words
    .map((w, k) => (k > 0 && base(w) === "git" ? words.slice(k + 1) : []))
    .filter((gitArgs) => gitArgs.includes("push"))
    .map((gitArgs) => evaluateGit(scope.policy, gitArgs, scope.cwd, scope.call))
    .filter((d) => d.effect === "deny");
}

function evaluateSegment(ctx: Ctx, seg: Segment, cwd: string): Decision {
  const { policy } = ctx;
  const nested = { ...ctx, depth: ctx.depth + 1 };

  return worst([
    ...seg.redirects.flatMap((rd) => redirectChecks(policy, rd, cwd)),
    ...seg.words.flatMap((w) => secretWord(policy, w, cwd) ?? []),
    ...writeTargets(seg.words).flatMap((target) => deniedWrite(policy, target, cwd)),
    ...secretVariable(seg.vars),
    ...seg.subs.map((sub) => judgeLine(nested, sub, [cwd])),
    judgeCommand(ctx, seg.words, cwd),
  ]);
}

function redirectChecks(policy: Policy, rd: Redirect, cwd: string): Decision[] {
  // A here-string's target is data, not a file.
  if (rd.op === "<<<") {
    return [];
  }

  if (rd.op === "<") {
    const d = secretWord(policy, rd.target, cwd);

    return d ? [d] : [];
  }

  return deniedWrite(policy, rd.target, cwd);
}

function deniedWrite(policy: Policy, target: string, cwd: string): Decision[] {
  const d = checkPath(policy, "write", target, cwd);

  return d.rule === "paths.write.deny" ? [d] : [];
}

function secretVariable(vars: string[]): Decision[] {
  const secretVar = vars.find((v) => SECRET_VAR.test(v));

  return secretVar
    ? [
        deny(
          `$${secretVar} is a credential by its name; expanding it could print it.`,
          "secrets.variable",
        ),
      ]
    : [];
}

/** Where `cd <target>` (or `pushd`) leads from `cwd`; the unknown directory when it cannot be followed. */
function cdTarget(policy: Policy, words: string[], cwd: string): string {
  const target = words.slice(1).find((w) => !w.startsWith("-"));
  if (cannotFollow(words[0], target, cwd)) {
    return UNKNOWN_CWD;
  }

  return resolvePath(target ?? "~", cwd, policy.home);
}

function cannotFollow(
  command: string | undefined,
  target: string | undefined,
  cwd: string,
): boolean {
  if (command === "popd" || target === "-") {
    return true;
  }

  if (target === undefined) {
    return false;
  }

  // From an unknown directory only an absolute or home-relative target leads somewhere known.
  return isDynamic(target) || (cwd === UNKNOWN_CWD && !/^[/~]/.test(target));
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
    results.push(...cwds.map((cwd) => evaluateSegment(ctx, seg, cwd)));
    cwds = cwdsAfter(ctx.policy, seg, cwds);
    if (cwds.length > MAX_CWDS) {
      return deny("Too many directory changes to track.", "shell.cd");
    }
  }

  return worst(results.length > 0 ? results : [allow("Empty command.")]);
}

/** The directories the shell may be in after a segment. */
function cwdsAfter(policy: Policy, seg: Segment, cwds: string[]): string[] {
  if (!MOVES.has(seg.words[0] ?? "") || isDetached(seg)) {
    return cwds;
  }

  const moved = cwds.map((c) => cdTarget(policy, seg.words, c));

  return seg.sep === "&&" ? [...new Set(moved)] : [...new Set([...cwds, ...moved])];
}

/** A segment in a pipeline or run in the background runs in a subshell; its `cd` does not move the shell. */
function isDetached(seg: Segment): boolean {
  return seg.sep === "|" || seg.sep === "&" || seg.before === "|";
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

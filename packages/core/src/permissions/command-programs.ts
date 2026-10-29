import { WRAPPERS, envCommand, findCommands, wrapped } from "./command-words.js";
import { deny } from "./decision.js";
import { evaluateGit } from "./git.js";
import { resolvePath } from "./paths.js";
import { holdsSecrets } from "./secrets.js";
import type { CommandScope, Decision } from "./types.js";

/** Judges what a program does beyond the command rules, from its arguments. */
type ProgramJudge = (args: string[], scope: CommandScope) => Decision[];

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

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"];

/** The checks a program brings beyond the command rules: the commands it runs, and what it would destroy or read. */
export function programChecks(program: string, args: string[], scope: CommandScope): Decision[] {
  const judge = PROGRAMS.get(program) ?? wrapper(program);

  return [...(judge?.(args, scope) ?? []), ...treeReads(program, args, scope)];
}

/** `nohup`, `xargs` and the other wrappers run the command after their own options. */
function wrapper(program: string): ProgramJudge | undefined {
  const spec = WRAPPERS[program];

  return spec ? (args, scope) => [scope.inner(wrapped(spec, args))] : undefined;
}

/** `env` with a command runs it; without one it is refused before this is asked. */
function env(args: string[], scope: CommandScope): Decision[] {
  const run = envCommand(args);
  if (run === null) {
    return [];
  }

  return ["script" in run ? scope.script(run.script) : scope.inner(run.words)];
}

/** `sh -c '...'` and the like run their script. */
function shell(args: string[], scope: CommandScope): Decision[] {
  const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
  const script = at >= 0 ? args[at + 1] : undefined;

  return script === undefined ? [] : [scope.script(script)];
}

function treeReads(program: string, args: string[], scope: CommandScope): Decision[] {
  if (!TREE_READERS.has(program)) {
    return [];
  }

  const { policy, cwd } = scope;

  return args
    .filter((a) => !a.startsWith("-") && holdsSecrets(policy, resolvePath(a, cwd, policy.home)))
    .map((a) => deny(`${program} ${a} would read the secrets folder.`, "paths.read.deny"));
}

const PROGRAMS = new Map<string, ProgramJudge>([
  ["env", env],
  ...SHELLS.map((name): [string, ProgramJudge] => [name, shell]),
  ["eval", (args, scope) => [scope.script(args.join(" "))]],
  ["find", (args, scope) => findCommands(args).map(scope.inner)],
  ["git", (args, scope) => [evaluateGit(scope.policy, args, scope.cwd, scope.call)]],
]);

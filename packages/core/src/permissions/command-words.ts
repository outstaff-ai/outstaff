/**
 * Programs that run the command after their own options. `valued` options take a value; `skip` is the number of
 * positional arguments before the command (the duration of `timeout`, the lock file of `flock`).
 */
export const WRAPPERS: Record<string, { valued?: string[]; skip?: number }> = {
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

export const base = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

export const isDynamic = (word: string): boolean => /[$`]/.test(word);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** env options that take their value as the next word. */
const ENV_VALUED = new Set(["-u", "-C", "--unset", "--chdir"]);

/** The command `env` runs, or null when it runs none and so prints the environment. */
export function envCommand(args: string[]): { words: string[] } | { script: string } | null {
  const options = readEnvOptions(args);
  if ("script" in options) {
    return options;
  }

  let i = options.next;
  while (i < args.length && ASSIGNMENT.test(args[i]!)) {
    i++;
  }

  return i < args.length ? { words: args.slice(i) } : null;
}

/** Reads env's options: where its operands start, or the command line `-S` hands it as one string. */
function readEnvOptions(args: string[]): { next: number } | { script: string } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      return { next: i + 1 };
    }

    const script = splitString(args, i);
    if (script !== undefined) {
      return { script };
    }

    if (ENV_VALUED.has(a)) {
      i++;
    } else if (!a.startsWith("-")) {
      return { next: i };
    }
  }

  return { next: args.length };
}

/** The script of a `-S`/`--split-string` option at `i`, which env splits into a command line of its own. */
function splitString(args: string[], i: number): string | undefined {
  const a = args[i]!;
  if (a === "-S" || a === "--split-string") {
    return args.slice(i + 1).join(" ");
  }

  if (a.startsWith("--split-string=")) {
    return [a.slice(15), ...args.slice(i + 1)].join(" ");
  }
}

/** The command a wrapper runs after its own options, or an empty list when it runs none. */
export function wrapped(spec: { valued?: string[]; skip?: number }, args: string[]): string[] {
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
export function findCommands(args: string[]): string[][] {
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
export function writeTargets(input: string[]): string[] {
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

import type { ConfigFs, GitClient } from "@outstaff/core";

/** Everything a command touches outside its own arguments, so tests can run commands in-process. */
export type Context = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Overrides for the team loader (tests only). */
  fs?: ConfigFs;
  git?: GitClient;
  cacheDir?: string;
  /** Returns the origin URL of the repository in `cwd`, or undefined. */
  gitOrigin: (cwd: string) => string | undefined;
};

export type GlobalOptions = { team?: string; json?: boolean };

export type OptionDef = {
  flags: string;
  description: string;
};

export type CommandDef<O = Record<string, unknown>> = {
  name: string;
  summary: string;
  description: string;
  options: OptionDef[];
  examples: string[];
  /** One line per exit code. */
  exitCodes: string[];
  /** Resolves to the process exit code. */
  run: (ctx: Context, options: O & GlobalOptions) => Promise<number>;
};

export function defineCommand<O>(def: CommandDef<O>): CommandDef {
  return def as unknown as CommandDef;
}

export const GLOBAL_OPTIONS: OptionDef[] = [
  {
    flags: "--team <path|git-url>",
    description:
      "Team config to use: a file, a directory, or a git URL with an optional #ref. Defaults to OUTSTAFF_TEAM_FILE, OUTSTAFF_TEAM_REPO, then ./.outstaff/team.yaml or ./team.yaml.",
  },
  { flags: "--json", description: "Print machine-readable JSON instead of text." },
  { flags: "-v, --version", description: "Print the version." },
  { flags: "-h, --help", description: "Show help." },
];

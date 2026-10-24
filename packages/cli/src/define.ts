import type { AgentEnv, OfficeClient } from "@outstaff/agent";
import type { AdapterRegistry, ConfigFs, GitClient } from "@outstaff/core";

/** Everything a command touches outside its own arguments, so tests can run commands in-process. */
export type Context = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;

  /** Everything on standard input; used by `git-credential`. */
  stdin?: () => Promise<string>;

  /** Overrides for the team loader (tests only). */
  fs?: ConfigFs;
  git?: GitClient;
  cacheDir?: string;

  /** Overrides the installed `@outstaff/catalog` package root (tests only). */
  stockCatalogDir?: string;

  /** Adapters available to agent verbs; defaults to the ones this build ships. */
  registry?: AdapterRegistry;

  /** The office connection for `ask`, `work` and `roster`; none until the office protocol exists. */
  office?: OfficeClient;

  /** Replaces building the agent environment from the team file (tests only). */
  agentEnv?: () => Promise<AgentEnv>;

  /** HTTP for `ost setup --derive`; defaults to the global `fetch` (tests only). */
  fetch?: typeof fetch;
  now?: () => Date;

  /** How long `ost doctor` waits for the office's handshake; tests only. */
  officeTimeoutMs?: number;

  /** Home directory, where `ost setup --derive` looks for a downloaded key in `Downloads`; defaults to the user's. */
  home?: string;

  /** Asks a yes/no question; absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;

  /** Asks for a line of text and returns `fallback` when the answer is empty; absent when there is no terminal to ask on. */
  ask?: (question: string, fallback: string) => Promise<string>;

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

  /** Makes the command `ost <group> <name>`. */
  group?: string;
  summary: string;
  description: string;

  /** Positional arguments in commander syntax, for example "<handle>". */
  args?: string;
  options: OptionDef[];
  examples: string[];

  /** One line per exit code. */
  exitCodes: string[];

  /** Resolves to the process exit code. */
  run: (ctx: Context, options: O & GlobalOptions, args: string[]) => Promise<number>;
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

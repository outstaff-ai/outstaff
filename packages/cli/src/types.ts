import type { AgentEnv, MiseRunner, OfficeClient } from "@outstaff/agent";
import type * as OfficeModule from "@outstaff/office";
import type {
  AdapterRegistry,
  Catalog,
  CatalogIssue,
  ConfigFs,
  ConfigIssue,
  ConfigSource,
  GitClient,
  LocatedIssue,
  TeamConfig,
} from "@outstaff/core";

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

  /** Runs mise for `ost doctor`'s tool check; defaults to the `mise` on the PATH (tests only). */
  mise?: MiseRunner;

  /** Whether host:port accepts a TCP connection, for `ost doctor`'s adb checks; defaults to a real connection (tests only). */
  tcpProbe?: (host: string, port: number) => Promise<boolean>;

  /** Whether `adb` runs, for `ost doctor`; defaults to running `adb version` (tests only). */
  adbProbe?: () => Promise<boolean>;

  /** Home directory, where `ost setup --derive` looks for a downloaded key in `Downloads`; defaults to the user's. */
  home?: string;

  /** Asks a yes/no question; absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;

  /** Asks for a line of text and returns `fallback` when the answer is empty; absent when there is no terminal to ask on. */
  ask?: (question: string, fallback: string) => Promise<string>;

  /** Loads `@outstaff/office` for `ost explain`; defaults to importing it (tests only). */
  loadOffice?: () => Promise<typeof OfficeModule>;

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

export type TeamCatalogs = { stock: Catalog; ejected?: Catalog };
export type CatalogsResult =
  | { ok: true; catalogs: TeamCatalogs }
  | { ok: false; issues: CatalogIssue[] };

export type Loaded =
  | {
      ok: true;
      config: TeamConfig;
      source: ConfigSource;

      /** The team file as written, parsed; tells a value the team set from a default. */
      raw: unknown;
      locate: (issue: ConfigIssue) => LocatedIssue;
    }
  | { ok: false; issues: LocatedIssue[] };

export type SecretsLocation = {
  /** Where the files of this scope are read and written. */
  dir: string;

  /** What belongs in `.gitignore`: the secrets directory as a whole. */
  ignoreDir: string;
};

/** What `ost hire` writes for one person. Optional fields are left out of the file when absent. */
export type NewPerson = {
  handle: string;
  name: string;
  pronouns: string;
  role: string;
  model?: string;
  repos: Record<string, "read" | "write">;
  avatar?: { seed: string } | { url: string };
};

export type Removal = {
  yaml: string;

  /** Usage groups that listed the person: the members before, and after (null when the group was dropped). */
  usage: { before: string[]; after: string[] | null }[];

  /** Other places that still mention the handle, as dotted paths; left as they are. */
  references: string[];
};

export type EjectedRecord = { version: string; sha256: string };
export type EjectedIndex = Record<string, EjectedRecord>;

export type MergeResult = { text: string; conflicts: number };

export type OpenedTeam = {
  config: TeamConfig;
  source: ConfigSource;

  /** Absolute path of the ejected catalog directory. */
  dir: string;
  stockDir: string;
};

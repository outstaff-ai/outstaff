import type { z } from "zod";
import type { Capability } from "#/types.js";
import type { TeamConfig } from "#/config/types.js";
import type { PROFILES, TOOL_KINDS } from "./constants.js";
import type {
  optionValueSchema,
  teamCommandSchema,
  teamCommandsSchema,
  toolDeclarationSchema,
  toolRuleSchema,
  toolsetSchema,
  toolsSchema,
} from "./schema.js";

export type ToolKind = (typeof TOOL_KINDS)[number];

export type Profile = (typeof PROFILES)[number];

export type GitMode = "read" | "write";

/** Absolute glob patterns. `deny` always wins over `allow`. */
export interface PathRules {
  allow: string[];
  deny: string[];
}

/**
 * A condition on the arguments that follow the program and its subcommand path.
 * The `flag` kind: a flag from `names` is (present: true) or is not (present: false) on the command line.
 */
export type ArgPredicate =
  | { kind: "flag"; names: string[]; present: boolean }

  /** A flag from `names` is present and its value is (in) or is not (not-in) one of `values`, compared case-insensitively. */
  | { kind: "flag-value"; names: string[]; values: string[]; match: "in" | "not-in" }

  /** The positional argument at `index` (after the subcommand path) matches the regular expression `pattern` (case-insensitive). */
  | { kind: "positional"; index: number; pattern: string };

export interface CommandRule {
  id: string;
  program: string;

  /** Leading positional words, for example ["pr", "create"]. */
  subcommand?: string[];

  /** Every predicate must hold for the rule to apply. */
  args?: ArgPredicate[];
  effect: "allow" | "deny";
  reason: string;

  /** Positional arguments are paths that must pass the read or write path rules. */
  pathArgs?: "read" | "write";

  /** The working repository must have at least this grant (write implies read). */
  requiresRepo?: GitMode;

  /**
   * A built-in default deny, such as mutating kubectl verbs. It applies only while no allow rule names the program, so a
   * tool declaration or a team rule that allows the program lifts it.
   */
  fallback?: boolean;
}

/**
 * Command rules from one source: adapters (the integration's own CLI), toolsets (catalog data per image variant), tool
 * declarations and the team (team.yaml). A program no allow rule names runs with any arguments; once an allow rule
 * names a program, the program runs only what such rules allow. Deny wins over allow whatever the source.
 */
export interface RulePack {
  id: string;
  source: "adapter" | "toolset" | "team";

  /** Profiles the rules apply to; every profile when omitted. */
  profiles?: Profile[];
  rules: CommandRule[];
}

export interface Policy {
  profile: Profile;

  /** Used to expand `~` and as the working directory when a call gives none. */
  home: string;
  defaultCwd: string;
  tools: { allow: ToolKind[]; deny: ToolKind[] };
  paths: { read: PathRules; write: PathRules };

  /**
   * The folder of secret files. Any shell command that names it is denied, whatever the program, on top of the
   * `paths.read.deny` globs.
   */
  secretsDir: string;

  /**
   * Rules for non-git programs. Anything no rule denies is allowed: the sandbox, the deployment's network policy and
   * per-person identities are the boundary, not this list. Git is judged by the push rules driven by `git`.
   */
  commands: CommandRule[];
  git: {
    /** Absolute repository or worktree root -> grant. The longest matching prefix of the working directory wins. */
    repos: Record<string, GitMode>;

    /** Same keys as `repos`. */
    defaultBranches: Record<string, string>;
  };

  /** The `ost` verbs the profile may call, by verb name (`ticket.create`). Every verb when omitted. */
  ost?: { allow: string[] };
}

export interface ToolCall {
  kind: ToolKind;
  path?: string;

  /** More files the call reads (an artifact publish names its sources); each must pass the read rules. */
  paths?: string[];
  command?: string;
  cwd?: string;

  /** Branch checked out in the working repository, when the runtime knows it. Lets bare `git push` be judged. */
  currentBranch?: string;
}

export interface Decision {
  effect: "allow" | "deny";
  reason: string;
  rule?: string;
}

export interface Layout {
  home: string;
  workDir: string;

  /** Clones live at `<reposDir>/<repo name>`. */
  reposDir: string;

  /** Worktrees live at `<worktreesDir>/<repo name>/<anything>`. */
  worktreesDir: string;
  scratchDir: string;
  memoryDir: string;
  secretsDir: string;
}

export type PathVerdict = "allow" | "denied" | "outside";

export type ToolOptionValue = z.output<typeof optionValueSchema>;
export type ToolRuleInput = z.input<typeof toolRuleSchema>;
export type ToolDeclaration = z.output<typeof toolDeclarationSchema>;
export type Tools = z.output<typeof toolsSchema>;
export type Toolset = z.output<typeof toolsetSchema>;
export type TeamCommands = z.output<typeof teamCommandsSchema>;
export type CommandRuleInput = z.input<typeof teamCommandSchema>;

export type ToolOrigin = "toolset" | "team" | "person";

/** A tool after precedence is applied: the declaration that wins for its name, and where it came from. */
export interface EffectiveTool extends ToolDeclaration {
  name: string;
  origin: ToolOrigin;

  /** The toolset that declared it, when `origin` is "toolset". */
  toolset?: string;
  profiles?: Profile[];
}

export interface EffectiveToolsInput {
  /** In order of precedence from lowest: a later toolset replaces an earlier one. */
  toolsets?: Toolset[];
  team?: Tools | undefined;
  person?: Tools | undefined;
}

export type PermissionPerson = Pick<TeamConfig["people"][number], "repos">;
export type PermissionTeam = Pick<TeamConfig, "repos">;

export interface BuildPolicyInput {
  profile: Profile;
  person: PermissionPerson;
  team: PermissionTeam;
  layout: Layout;

  /** Rules from adapters, toolsets and the team, merged after the built-in ones. */
  packs?: RulePack[];

  /** The profile whose rule packs apply; defaults to `profile`. A chat session takes those of its role's profile. */
  packsOf?: Profile;

  /**
   * Capabilities the person's role declares and the team has switched on. `design.canvas` adds the artifact tool and
   * the artifacts folder; no profile has them by itself.
   */
  capabilities?: readonly Capability[];
}

export interface ProfileSpec {
  tools: ToolKind[];

  /** Whether write grants are honoured (git write verbs, edits in worktrees). */
  honoursWrite: boolean;

  /** Which files of a write repository's worktree the edit tools may change; "all" is every file. */
  writable: "none" | "docs" | "all";

  /** The `ost` verbs the profile may call. Every verb when omitted. */
  verbs?: string[];
}

/** What the options of a `git push` say, and its remaining words. */
export interface PushArgs {
  /** The push deletes the remote branch (`--delete`, `-d`). */
  del: boolean;

  /** The push is a lease push (`--force-with-lease`, `--force-if-includes`). */
  forceLease: boolean;
  positionals: string[];
}

/** A repository granted to the person, as found from a working directory. */
export interface GitRepo {
  dir: string;
  mode: GitMode;
  defaultBranch: string;
}

/** What the global options of a git command (before the subcommand) say. */
export interface GitGlobals {
  /** The directory git runs in, after any `-C`. */
  cwd: string;

  /** An option such as `--git-dir` points git at a repository other than the directory's. */
  redirected: boolean;

  /** Index of the subcommand in the arguments. */
  next: number;
}

/** A git subcommand to judge, inside a granted repository. */
export interface GitSubcommand {
  sub: string;
  rest: string[];
  repo: GitRepo;
  currentBranch: string | undefined;
}

/** A command being judged: where it runs, and how to judge the commands it runs in turn. */
export interface CommandScope {
  policy: Policy;
  call: ToolCall;
  cwd: string;

  /** Judges a command it runs, given as words. */
  inner: (words: string[]) => Decision;

  /** Judges a command line it runs, given as text. */
  script: (text: string) => Decision;
}

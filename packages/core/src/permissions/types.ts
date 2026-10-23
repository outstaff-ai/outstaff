export const TOOL_KINDS = [
  "read",
  "write",
  "edit",
  "search",
  "shell",
  "web_fetch",
  "subagent",
  "ost",
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export const PROFILES = ["readonly", "docs", "code", "infra"] as const;
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
}

/**
 * Command rules from one source. Core knows only git and raw network tools; everything else comes from packs:
 * adapters (the integration's own CLI), toolsets (catalog data per image variant) and the team (team.yaml).
 * Deny wins over allow whatever the source.
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

  /** Non-git programs. Git is judged by the push and verb rules driven by `git`. */
  commands: CommandRule[];
  git: {
    /** Absolute repository or worktree root -> grant. The longest matching prefix of the working directory wins. */
    repos: Record<string, GitMode>;

    /** Same keys as `repos`. */
    defaultBranches: Record<string, string>;
  };
  network: { raw: "deny" };
}

export interface ToolCall {
  kind: ToolKind;
  path?: string;
  command?: string;
  cwd?: string;

  /** Branch checked out in the working repository, when the runtime knows it. Lets bare `git push` be judged. */
  currentBranch?: string;
}

export interface Decision {
  /** `ask` means the policy does not cover the call; unattended runtimes treat it as deny. */
  effect: "allow" | "deny" | "ask";
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

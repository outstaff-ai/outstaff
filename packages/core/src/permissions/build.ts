import type { Capability } from "../capabilities.js";
import type { TeamConfig } from "../config/schema.js";
import type { CommandRule, GitMode, Layout, Policy, Profile, RulePack, ToolKind } from "./types.js";

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

/** Where a person's Design canvas files live; the folder stays across items. */
export const artifactsDir = (layout: Pick<Layout, "home">): string => `${layout.home}/artifacts`;

interface ProfileSpec {
  tools: ToolKind[];

  /** Whether write grants are honoured (git write verbs, edits in worktrees). */
  honoursWrite: boolean;

  /** Which files of a write repository's worktree the edit tools may change; "all" is every file. */
  writable: "none" | "docs" | "all";

  /** The `ost` verbs the profile may call. Every verb when omitted. */
  verbs?: string[];
}

/**
 * The verbs a chat session may call: look at the team, the work, tickets, documents and pull requests, comment, and
 * file work. Nothing that changes a ticket, a pull request or a document.
 */
export const CHAT_VERBS = [
  "me",
  "team",
  "work",
  "work.queue",
  "work.attach",
  "doc.search",
  "doc.show",
  "ticket.show",
  "ticket.comment",
  "ticket.create",
  "ticket.attach",
  "pr.status",
  "pr.checks",
  "pr.threads",
  "pr.conversation",
  "pr.diff",
  "pr.comment",
];

const WORK_TOOLS: ToolKind[] = [
  "read",
  "write",
  "edit",
  "search",
  "shell",
  "web_fetch",
  "subagent",
  "ost",
];

/**
 * Every profile runs any program inside the sandbox; the profiles differ in what they may change in repositories.
 *
 * readonly: read-only git even where a write grant exists; the edit tools change no repository file.
 * docs:     the edit tools change only documentation files (md, mdx, txt, rst and anything under docs/) in worktrees
 *           of write repos; git write verbs and pushes for write repos.
 * code:     the edit tools change any file in worktrees of write repos.
 * infra:    like code, for infrastructure repos.
 * chat:     a chat session beside a running work item. The same tools as a work session, but read-only git, no
 *           repository edits, and only the `ost` verbs in CHAT_VERBS.
 *
 * Every profile may write its scratch, memory, harness (`~/.claude`) and tmp folders.
 */
export const PROFILE_SPECS: Record<Profile, ProfileSpec> = {
  readonly: { tools: WORK_TOOLS, honoursWrite: false, writable: "none" },
  docs: { tools: WORK_TOOLS, honoursWrite: true, writable: "docs" },
  code: { tools: WORK_TOOLS, honoursWrite: true, writable: "all" },
  infra: { tools: WORK_TOOLS, honoursWrite: true, writable: "all" },
  chat: { tools: WORK_TOOLS, honoursWrite: false, writable: "none", verbs: CHAT_VERBS },
};

const DOC_GLOBS = ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/docs/**"];

/** Files that hold credentials wherever they are. The secrets folder and the process environment are added per layout. */
const SECRET_GLOBS = [
  "**/.env",
  "**/.env.local",
  "**/.env.*.local",
  "**/*.pem",
  "**/.git-credentials",
  "**/.netrc",
  "**/.ssh/id_*",
  "**/.claude/.credentials.json",
  "/proc/**/environ",
  "/proc/**/mem",
];

/** Programs that change the user the command runs as, or leave the sandbox's view of the system. */
const PRIVILEGE_TOOLS = [
  "sudo",
  "doas",
  "su",
  "pkexec",
  "runuser",
  "nsenter",
  "chroot",
  "setpriv",
  "capsh",
];

/** Infrastructure writes, denied unless a tool declaration or team rule allows the program. */
const INFRA_WRITES: { program: string; verbs: string[]; sub?: Record<string, string> }[] = [
  {
    program: "kubectl",
    verbs: [
      "apply",
      "create",
      "delete",
      "edit",
      "patch",
      "replace",
      "scale",
      "autoscale",
      "set",
      "label",
      "annotate",
      "taint",
      "cordon",
      "uncordon",
      "drain",
      "expose",
      "run",
      "exec",
      "cp",
      "debug",
      "attach",
      "certificate",
    ],
    sub: { rollout: "^(restart|undo|pause|resume)$" },
  },
  { program: "helm", verbs: ["install", "upgrade", "uninstall", "delete", "rollback"] },
  ...["terraform", "tofu"].map((program) => ({
    program,
    verbs: ["apply", "destroy", "import", "taint", "untaint", "force-unlock"],
    sub: { state: "^(rm|mv|push|replace-provider)$" },
  })),
  {
    program: "pulumi",
    verbs: ["up", "update", "destroy", "refresh", "import", "cancel"],
    sub: { stack: "^(rm|remove)$" },
  },
];

/**
 * What Claude Code loads as configuration, and the rendered working directory (skills, references, the project
 * settings source). Never writable, even where a broader allow covers them, so no file there becomes a way to persist
 * instructions or hooks across sessions.
 */
function harnessConfig(layout: Layout): string[] {
  const claude = `${layout.home}/.claude`;
  return [
    `${claude}/settings*.json`,
    `${claude}/CLAUDE.md`,
    `${claude}/*.md`,
    ...["hooks", "skills", "agents", "commands", "plugins", "output-styles", "rules"].map(
      (d) => `${claude}/${d}/**`,
    ),
    `${claude}/projects/*/settings*.json`,
    `${layout.home}/.claude.json`,
    `${layout.home}/.mcp.json`,
    `${layout.workDir}/**`,
  ];
}

const rule = (r: CommandRule): CommandRule => r;

/** The built-in command rules: privilege tools are denied, infrastructure writes are denied by default. */
export function commandRules(): CommandRule[] {
  const rules: CommandRule[] = PRIVILEGE_TOOLS.map((program) =>
    rule({
      id: `privilege.${program}`,
      program,
      effect: "deny",
      reason: `${program} runs commands with other privileges.`,
    }),
  );

  for (const { program, verbs, sub } of INFRA_WRITES) {
    const reason = (what: string) =>
      `${program} ${what} changes infrastructure; it runs only when a tools declaration or team rule allows ${program}.`;

    for (const verb of verbs) {
      rules.push(
        rule({
          id: `infra.${program}.${verb}`,
          program,
          subcommand: [verb],
          effect: "deny",
          fallback: true,
          reason: reason(verb),
        }),
      );
    }

    for (const [word, pattern] of Object.entries(sub ?? {})) {
      rules.push(
        rule({
          id: `infra.${program}.${word}`,
          program,
          subcommand: [word],
          args: [{ kind: "positional", index: 0, pattern }],
          effect: "deny",
          fallback: true,
          reason: reason(word),
        }),
      );
    }
  }

  return rules;
}

/** Whether a profile honours write grants; the one place that decides it. */
export const profileAllowsWrite = (profile: Profile): boolean =>
  PROFILE_SPECS[profile].honoursWrite;

/** The grant a person has on a repo: by name, then `kind:<kind>`, then `*`. */
export function repoGrant(
  person: Pick<PermissionPerson, "repos">,
  repo: PermissionTeam["repos"][number],
): GitMode | undefined {
  return person.repos[repo.name] ?? person.repos[`kind:${repo.kind}`] ?? person.repos["*"];
}

/**
 * The strongest grant a person has on any repository of the team: "none" when no repository resolves to a grant,
 * "write" when any does. Decides which credentials the person needs from the code host.
 */
export function repoAccess(
  team: PermissionTeam,
  person: PermissionPerson,
): "none" | "read" | "write" {
  let access: "none" | "read" | "write" = "none";
  for (const repo of team.repos) {
    const granted = repoGrant(person, repo);
    if (granted === "write") {
      return "write";
    }

    if (granted) {
      access = "read";
    }
  }

  return access;
}

export function buildPolicy({
  profile,
  person,
  team,
  layout,
  packs = [],
  packsOf = profile,
  capabilities = [],
}: BuildPolicyInput): Policy {
  for (const [name, dir] of [
    ["reposDir", layout.reposDir],
    ["worktreesDir", layout.worktreesDir],
    ["secretsDir", layout.secretsDir],
  ] as const) {
    if (dir === layout.workDir || dir.startsWith(`${layout.workDir}/`)) {
      throw new Error(`Layout ${name} (${dir}) must not lie inside workDir (${layout.workDir}).`);
    }
  }

  const spec = PROFILE_SPECS[profile];
  const repos: Policy["git"]["repos"] = {};
  const defaultBranches: Policy["git"]["defaultBranches"] = {};
  const writeAllow: string[] = [
    `${layout.scratchDir}/**`,
    `${layout.memoryDir}/**`,
    // Claude Code's session memory and tool-result spill files; the rest of ~/.claude is configuration.
    `${layout.home}/.claude/projects/**`,
    "/tmp/**",
  ];

  for (const repo of team.repos) {
    const granted = repoGrant(person, repo);
    if (!granted) {
      continue;
    }

    const mode: GitMode = granted === "write" && spec.honoursWrite ? "write" : "read";
    for (const dir of [`${layout.reposDir}/${repo.name}`, `${layout.worktreesDir}/${repo.name}`]) {
      repos[dir] = mode;
      defaultBranches[dir] = repo.default_branch;
    }

    if (mode === "write" && spec.writable !== "none") {
      const wt = `${layout.worktreesDir}/${repo.name}`;
      writeAllow.push(
        ...(spec.writable === "docs" ? DOC_GLOBS.map((g) => `${wt}/${g}`) : [`${wt}/**`]),
      );
    }
  }

  const tools: ToolKind[] = [...spec.tools];
  if (capabilities.includes("design.canvas")) {
    tools.push("artifact");
    writeAllow.push(`${artifactsDir(layout)}/**`);
  }

  const readDeny = [`${layout.secretsDir}/**`, ...SECRET_GLOBS];
  return {
    profile,
    home: layout.home,
    defaultCwd: layout.workDir,
    secretsDir: layout.secretsDir,
    tools: { allow: tools, deny: [] },
    paths: {
      read: { allow: ["/**"], deny: readDeny },
      write: {
        allow: writeAllow,
        deny: [
          ...readDeny,
          "**/.git",
          "**/.git/**",
          `${layout.home}/.gitconfig`,
          `${layout.home}/.config/git/**`,
          ...harnessConfig(layout),
        ],
      },
    },
    commands: [
      ...commandRules(),
      ...packs.filter((p) => !p.profiles || p.profiles.includes(packsOf)).flatMap((p) => p.rules),
    ],
    git: { repos, defaultBranches },
    ...(spec.verbs ? { ost: { allow: [...spec.verbs] } } : {}),
  };
}

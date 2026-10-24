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
}

interface ProfileSpec {
  tools: ToolKind[];

  /** Whether write grants are honoured (git write verbs, edits in worktrees). */
  honoursWrite: boolean;

  /** Writable file globs relative to a worktree; "all" is every file. */
  writable: "none" | "docs" | "all";
  mutators: boolean;

  /** The `ost` verbs the profile may call. Every verb when omitted. */
  verbs?: string[];

  /** Whether rule packs apply when they name no profile. Default true. */
  anyPack?: boolean;
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
  "pr.status",
  "pr.threads",
  "pr.diff",
  "pr.comment",
];

/**
 * readonly: look but do not touch. Read and search, read-only git even where a write grant exists, no edits.
 * docs:     documentation work. Edits only documentation files (md, mdx, txt, rst and anything under docs/) in
 *           worktrees, scratch and memory; git write verbs and PR verbs for write repos.
 * code:     software work. Edits any file in worktrees of write repos.
 * infra:    like code, for infrastructure repos.
 * chat:     a chat session beside a running work item. Reads the repositories and the office state; writes no file,
 *           pushes nothing, and calls only the `ost` verbs in CHAT_VERBS. Only rule packs that name this profile apply.
 *
 * Which tools each profile may run (build tools, infra CLIs, an integration's CLI) comes from rule packs.
 */
export const PROFILE_SPECS: Record<Profile, ProfileSpec> = {
  readonly: {
    tools: ["read", "search", "shell", "ost"],
    honoursWrite: false,
    writable: "none",
    mutators: false,
  },
  docs: {
    tools: ["read", "write", "edit", "search", "shell", "web_fetch", "subagent", "ost"],
    honoursWrite: true,
    writable: "docs",
    mutators: true,
  },
  code: {
    tools: ["read", "write", "edit", "search", "shell", "web_fetch", "subagent", "ost"],
    honoursWrite: true,
    writable: "all",
    mutators: true,
  },
  infra: {
    tools: ["read", "write", "edit", "search", "shell", "web_fetch", "subagent", "ost"],
    honoursWrite: true,
    writable: "all",
    mutators: true,
  },
  chat: {
    tools: ["read", "search", "shell", "ost"],
    honoursWrite: false,
    writable: "none",
    mutators: false,
    verbs: CHAT_VERBS,
    anyPack: false,
  },
};

const DOC_GLOBS = ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/docs/**"];

const SECRET_GLOBS = ["**/.env", "**/.env.local", "**/.env.*.local", "**/*.pem"];

const READ_UTILS = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "sort",
  "uniq",
  "diff",
  "cut",
  "tr",
  "jq",
  "tree",
  "stat",
  "file",
  "realpath",
  "basename",
  "dirname",
  "du",
];

const NO_PATH_UTILS = ["pwd", "echo", "date", "true", "false", "which"];
const MUTATORS = ["mkdir", "touch", "rm", "cp", "mv", "tee"];
const NETWORK_TOOLS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "socat",
];

const WRAPPERS = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "eval",
  "sudo",
  "doas",
  "su",
  "env",
  "xargs",
  "exec",
  "nohup",
  "command",
  "builtin",
  "source",
  ".",
  "time",
  "watch",
];

const rule = (r: CommandRule): CommandRule => r;

export function commandRules(spec: ProfileSpec): CommandRule[] {
  const rules: CommandRule[] = [];
  for (const program of NETWORK_TOOLS) {
    rules.push(
      rule({
        id: `network.${program}`,
        program,
        effect: "deny",
        reason: `Raw network tool ${program} is denied; use ost verbs.`,
      }),
    );
  }

  for (const program of WRAPPERS) {
    rules.push(
      rule({
        id: `wrapper.${program}`,
        program,
        effect: "deny",
        reason: `${program} can run commands the policy cannot see.`,
      }),
    );
  }

  for (const program of READ_UTILS) {
    rules.push(
      rule({
        id: `read.${program}`,
        program,
        effect: "allow",
        pathArgs: "read",
        reason: `${program} reads files.`,
      }),
    );
  }

  rules.push(
    rule({
      id: "find.exec",
      program: "find",
      args: [
        {
          kind: "flag",
          names: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint"],
          present: true,
        },
      ],
      effect: "deny",
      reason: "find that runs commands or deletes is denied.",
    }),
    rule({
      id: "read.find",
      program: "find",
      effect: "allow",
      pathArgs: "read",
      reason: "find reads the file tree.",
    }),
    rule({
      id: "sed.inplace",
      program: "sed",
      args: [{ kind: "flag", names: ["-i", "--in-place"], present: true }],
      effect: "deny",
      reason: "In-place sed is denied; use the edit tool.",
    }),
    rule({
      id: "read.sed",
      program: "sed",
      effect: "allow",
      pathArgs: "read",
      reason: "sed to stdout reads files.",
    }),
  );

  for (const program of NO_PATH_UTILS) {
    rules.push(
      rule({ id: `util.${program}`, program, effect: "allow", reason: `${program} is harmless.` }),
    );
  }

  if (spec.mutators) {
    for (const program of MUTATORS) {
      rules.push(
        rule({
          id: `write.${program}`,
          program,
          effect: "allow",
          pathArgs: "write",
          reason: `${program} within writable paths.`,
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
  const readAllow = [
    `${layout.workDir}/**`,
    layout.reposDir,
    layout.worktreesDir,
    `${layout.scratchDir}/**`,
    `${layout.memoryDir}/**`,
  ];

  const writeAllow: string[] = [`${layout.scratchDir}/**`, `${layout.memoryDir}/**`];
  const writeAllowDocsOnly = spec.writable === "docs";
  if (spec.writable === "none") {
    writeAllow.length = 0;
  }

  for (const repo of team.repos) {
    const granted = repoGrant(person, repo);
    if (!granted) {
      continue;
    }

    const mode: GitMode = granted === "write" && spec.honoursWrite ? "write" : "read";
    for (const dir of [`${layout.reposDir}/${repo.name}`, `${layout.worktreesDir}/${repo.name}`]) {
      repos[dir] = mode;
      defaultBranches[dir] = repo.default_branch;
      readAllow.push(`${dir}/**`);
    }

    if (mode === "write" && spec.writable !== "none") {
      const wt = `${layout.worktreesDir}/${repo.name}`;
      if (writeAllowDocsOnly) {
        writeAllow.push(...DOC_GLOBS.map((g) => `${wt}/${g}`));
      } else {
        writeAllow.push(`${wt}/**`);
      }
    }
  }

  const readDeny = [`${layout.secretsDir}/**`, ...SECRET_GLOBS];
  return {
    profile,
    home: layout.home,
    defaultCwd: layout.workDir,
    tools: { allow: [...spec.tools], deny: [] },
    paths: {
      read: { allow: readAllow, deny: readDeny },
      write: { allow: writeAllow, deny: [...readDeny, "**/.git", "**/.git/**"] },
    },
    commands: [
      ...commandRules(spec),
      ...packs
        .filter((p) => (p.profiles ? p.profiles.includes(profile) : spec.anyPack !== false))
        .flatMap((p) => p.rules),
    ],
    git: { repos, defaultBranches },
    network: { raw: "deny" },
    ...(spec.verbs ? { ost: { allow: [...spec.verbs] } } : {}),
  };
}

import { commandRules } from "./builtin-rules.js";
import { PROFILE_SPECS } from "./profiles.js";
import type {
  BuildPolicyInput,
  GitMode,
  Layout,
  PermissionPerson,
  PermissionTeam,
  Policy,
  ProfileSpec,
  ToolKind,
} from "./types.js";

/** Where a person's Design canvas files live; the folder stays across items. */
export const artifactsDir = (layout: Pick<Layout, "home">): string => `${layout.home}/artifacts`;

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
  assertLayout(layout);
  const spec = PROFILE_SPECS[profile];
  const git = gitGrants(person, team, layout, spec);
  const canvas = capabilities.includes("design.canvas");
  const tools: ToolKind[] = [...spec.tools, ...(canvas ? (["artifact"] as const) : [])];
  const writeAllow = [
    `${layout.scratchDir}/**`,
    `${layout.memoryDir}/**`,
    // Claude Code's session memory and tool-result spill files; the rest of ~/.claude is configuration.
    `${layout.home}/.claude/projects/**`,
    "/tmp/**",
    ...git.writeAllow,
    ...(canvas ? [`${artifactsDir(layout)}/**`] : []),
  ];

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
    git: { repos: git.repos, defaultBranches: git.defaultBranches },
    ...(spec.verbs ? { ost: { allow: [...spec.verbs] } } : {}),
  };
}

/** The repos, worktrees and secrets folders must lie outside the working directory. */
function assertLayout(layout: Layout): void {
  for (const [name, dir] of [
    ["reposDir", layout.reposDir],
    ["worktreesDir", layout.worktreesDir],
    ["secretsDir", layout.secretsDir],
  ] as const) {
    if (dir === layout.workDir || dir.startsWith(`${layout.workDir}/`)) {
      throw new Error(`Layout ${name} (${dir}) must not lie inside workDir (${layout.workDir}).`);
    }
  }
}

/** The person's repository grants under the profile, and the worktree paths they may write. */
function gitGrants(
  person: PermissionPerson,
  team: PermissionTeam,
  layout: Layout,
  spec: ProfileSpec,
): Policy["git"] & { writeAllow: string[] } {
  const grants: Policy["git"] & { writeAllow: string[] } = {
    repos: {},
    defaultBranches: {},
    writeAllow: [],
  };

  for (const repo of team.repos) {
    const granted = repoGrant(person, repo);
    if (!granted) {
      continue;
    }

    const mode: GitMode = granted === "write" && spec.honoursWrite ? "write" : "read";
    for (const dir of [`${layout.reposDir}/${repo.name}`, `${layout.worktreesDir}/${repo.name}`]) {
      grants.repos[dir] = mode;
      grants.defaultBranches[dir] = repo.default_branch;
    }

    if (mode === "write") {
      grants.writeAllow.push(...writableGlobs(spec, `${layout.worktreesDir}/${repo.name}`));
    }
  }

  return grants;
}

/** What the profile may write in a worktree it holds a write grant on. */
function writableGlobs(spec: ProfileSpec, worktree: string): string[] {
  if (spec.writable === "none") {
    return [];
  }

  return spec.writable === "docs" ? DOC_GLOBS.map((g) => `${worktree}/${g}`) : [`${worktree}/**`];
}

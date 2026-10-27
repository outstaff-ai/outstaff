import { commandRules } from "./builtin-rules.js";
import { PROFILE_SPECS } from "./profiles.js";
import type {
  BuildPolicyInput,
  GitMode,
  Layout,
  PermissionPerson,
  PermissionTeam,
  Policy,
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

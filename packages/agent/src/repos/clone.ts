import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRepoUrl, repoGrant, silentLogger, type GitMode, type RepoRef } from "@outstaff/core";
import { cappedAccess } from "./access.js";
import { runGit } from "./git.js";
import type { ClonedRepo, RunGit, SyncRepositoriesOptions } from "./types.js";

type TeamRepo = SyncRepositoriesOptions["team"]["repos"][number];
type Author = NonNullable<
  Awaited<ReturnType<SyncRepositoriesOptions["vcs"]["credentials"]>>["author"]
>;

/** Default credential helper of every clone. The `!` makes git run it as a shell command. */
export const CREDENTIAL_HELPER = "!ost git-credential";

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A pre-push hook that is a second line of defence behind the permission policy and the token's scope: a read-only
 * repository takes no pushes at all, and no repository takes a push to its default branch.
 */
export function prePushHook(access: GitMode, defaultBranch: string): string {
  const lines = [
    "#!/bin/sh",
    "# Written by ost-agent. Pushes are refused here as well as by policy.",
  ];

  if (access === "read") {
    lines.push('echo "ost: this repository is read-only; push is refused." >&2', "exit 1");
  } else {
    lines.push(
      `default=${shellQuote(`refs/heads/${defaultBranch}`)}`,
      "while read -r local_ref local_sha remote_ref remote_sha; do",
      '  if [ "$remote_ref" = "$default" ]; then',
      `    echo "ost: pushing to the default branch (${defaultBranch.replaceAll(/[^\w./-]/g, "?")}) is refused; push a branch and open a pull request." >&2`,
      "    exit 1",
      "  fi",
      "done",
      "exit 0",
    );
  }

  return `${lines.join("\n")}\n`;
}

const defaultRemote = (r: Required<RepoRef>) => `https://${r.host}/${r.owner}/${r.name}.git`;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The `-c` options that hand git's credentials to the helper alone, for a clone or fetch. */
const helperConfig = (helper: string) => [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${helper}`,
  "-c",
  "credential.useHttpPath=true",
];

/** Fetches a clone that is there, or clones into a directory that is absent or empty. */
async function fetchOrClone(git: RunGit, helper: string, dir: string, url: string) {
  const config = helperConfig(helper);
  if (existsSync(join(dir, ".git"))) {
    await git([...config, "fetch", "--prune", "origin"], { cwd: dir });

    return;
  }

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} exists and is not a git repository.`);
  }

  await git([...config, "clone", url, dir]);
}

/** Points the clone's credentials at the helper, and sets the commit author when the vcs gave one. */
async function configureClone(git: RunGit, dir: string, helper: string, author?: Author) {
  // Per clone: helper list reset first, so no global helper (a keychain, say) is ever offered the token.
  await git(["config", "--local", "--replace-all", "credential.helper", ""], { cwd: dir });
  await git(["config", "--local", "--add", "credential.helper", helper], { cwd: dir });
  await git(["config", "--local", "credential.useHttpPath", "true"], { cwd: dir });
  if (author) {
    await git(["config", "--local", "user.name", author.name], { cwd: dir });
    await git(["config", "--local", "user.email", author.email], { cwd: dir });
  }
}

function writePrePushHook(dir: string, access: GitMode, defaultBranch: string) {
  const hooks = join(dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), prePushHook(access, defaultBranch), { mode: 0o755 });
}

async function prepareRepository(
  opts: SyncRepositoriesOptions,
  repo: TeamRepo,
  access: GitMode,
  ref: Required<RepoRef>,
): Promise<ClonedRepo> {
  const git = opts.git ?? runGit;
  const helper = opts.helper ?? CREDENTIAL_HELPER;
  const remote = opts.remoteUrl ?? defaultRemote;
  const dir = join(opts.reposDir, repo.name);
  const issued = await opts.vcs.credentials(opts.person, ref, access);
  await fetchOrClone(git, helper, dir, remote(ref));
  await configureClone(git, dir, helper, issued.author);
  writePrePushHook(dir, access, repo.default_branch);

  return {
    name: repo.name,
    dir,
    ref,
    defaultBranch: repo.default_branch,
    access,
    kind: repo.kind,
    instructions: repo.instructions ?? [],
    trackerLabels: repo.tracker?.labels ?? [],
  };
}

/**
 * Clones every team repo the person has a grant on into `<reposDir>/<name>`, or fetches it when it is there.
 * Repos without a grant are never touched. The credentials asked for here only validate the grant and give the
 * commit author: git itself gets its token from the credential helper, at each request.
 */
export async function syncRepositories(opts: SyncRepositoriesOptions): Promise<ClonedRepo[]> {
  const log = opts.log ?? silentLogger;
  const me = opts.team.people.find((p) => p.handle === opts.person);
  const out: ClonedRepo[] = [];
  if (!me) {
    return out;
  }

  mkdirSync(opts.reposDir, { recursive: true });
  for (const repo of opts.team.repos) {
    const grant = repoGrant(me, repo);
    if (!grant) {
      continue;
    }

    const access = cappedAccess(grant, opts.profile);
    const ref = parseRepoUrl(repo.url);
    try {
      out.push(await prepareRepository(opts, repo, access, ref));
    } catch (e) {
      log.warn("could not prepare a repository", { repo: repo.name, error: reason(e) });
    }
  }

  return out;
}

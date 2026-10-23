import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRepoUrl,
  repoGrant,
  silentLogger,
  type GitMode,
  type Profile,
  type Logger,
  type RepoRef,
  type TeamConfig,
  type Vcs,
} from "@outstaff/core";
import { cappedAccess } from "./access.js";
import { runGit, type RunGit } from "./git.js";

/** Default credential helper of every clone. The `!` makes git run it as a shell command. */
export const CREDENTIAL_HELPER = "!ost git-credential";

export interface ClonedRepo {
  /** The repo's short name in team.yaml. */
  name: string;
  dir: string;
  ref: Required<RepoRef>;
  defaultBranch: string;
  access: GitMode;
  kind: string;
}

export interface SyncRepositoriesOptions {
  team: TeamConfig;
  person: string;
  vcs: Vcs;

  /** The person's role profile; it caps the access a write grant gives. */
  profile: Profile;
  reposDir: string;
  git?: RunGit;
  log?: Logger;

  /** Where to clone from; default `https://<host>/<owner>/<name>.git`. */
  remoteUrl?: (repo: Required<RepoRef>) => string;

  /** The git credential helper command; default {@link CREDENTIAL_HELPER}. */
  helper?: string;
}

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

/**
 * Clones every team repo the person has a grant on into `<reposDir>/<name>`, or fetches it when it is there.
 * Repos without a grant are never touched. The credentials asked for here only validate the grant and give the
 * commit author: git itself gets its token from the credential helper, at each request.
 */
export async function syncRepositories(opts: SyncRepositoriesOptions): Promise<ClonedRepo[]> {
  const git = opts.git ?? runGit;
  const log = opts.log ?? silentLogger;
  const helper = opts.helper ?? CREDENTIAL_HELPER;
  const remote = opts.remoteUrl ?? defaultRemote;
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
    const dir = join(opts.reposDir, repo.name);
    try {
      const issued = await opts.vcs.credentials(opts.person, ref, access);
      const config = [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "-c",
        "credential.useHttpPath=true",
      ];

      if (existsSync(join(dir, ".git"))) {
        await git([...config, "fetch", "--prune", "origin"], { cwd: dir });
      } else if (existsSync(dir) && readdirSync(dir).length > 0) {
        throw new Error(`${dir} exists and is not a git repository.`);
      } else {
        await git([...config, "clone", remote(ref), dir]);
      }

      // Per clone: helper list reset first, so no global helper (a keychain, say) is ever offered the token.
      await git(["config", "--local", "credential.helper", ""], { cwd: dir });
      await git(["config", "--local", "--add", "credential.helper", helper], { cwd: dir });
      await git(["config", "--local", "credential.useHttpPath", "true"], { cwd: dir });
      if (issued.author) {
        await git(["config", "--local", "user.name", issued.author.name], { cwd: dir });
        await git(["config", "--local", "user.email", issued.author.email], { cwd: dir });
      }

      const hooks = join(dir, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-push"), prePushHook(access, repo.default_branch), {
        mode: 0o755,
      });

      out.push({
        name: repo.name,
        dir,
        ref,
        defaultBranch: repo.default_branch,
        access,
        kind: repo.kind,
      });
    } catch (e) {
      log.warn("could not prepare a repository", { repo: repo.name, error: reason(e) });
    }
  }

  return out;
}

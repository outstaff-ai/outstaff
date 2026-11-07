import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRepoUrl,
  PortError,
  repoGrant,
  silentLogger,
  type GitMode,
  type Logger,
  type RepoRef,
} from "@outstaff/core";
import { cappedAccess } from "./access.js";
import { moveToDefault } from "./base-clone.js";
import { runGit } from "./git.js";
import type {
  ClonedRepo,
  Repositories,
  RunGit,
  SyncRepositoriesOptions,
  UnpreparedRepo,
} from "./types.js";

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

/**
 * Makes a clone's `origin` the configured URL, so a repository that moved (another owner, a new name) is fetched where
 * it is now. The clone keeps its objects, refs and config.
 */
async function followUrl(git: RunGit, log: Logger, name: string, dir: string, url: string) {
  const current = await git(["remote", "get-url", "origin"], { cwd: dir }).then(
    (out) => out.trim(),
    () => undefined,
  );

  if (current === url) {
    return;
  }

  if (current === undefined) {
    await git(["remote", "add", "origin", url], { cwd: dir });
  } else {
    await git(["remote", "set-url", "origin", url], { cwd: dir });
  }

  log.info("the repository's URL changed, so its clone follows it", {
    repo: name,
    from: current ?? null,
    to: url,
  });
}

/** Fetches a clone that is there, from the configured URL, or clones into a directory that is absent or empty. */
async function fetchOrClone(
  git: RunGit,
  log: Logger,
  helper: string,
  repo: { name: string; dir: string; url: string },
) {
  const { name, dir, url } = repo;
  const config = helperConfig(helper);
  if (existsSync(join(dir, ".git"))) {
    await followUrl(git, log, name, dir, url);
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
  const log = opts.log ?? silentLogger;
  const helper = opts.helper ?? CREDENTIAL_HELPER;
  const remote = opts.remoteUrl ?? defaultRemote;
  const dir = join(opts.reposDir, repo.name);
  const issued = await opts.vcs.credentials(opts.person, ref, access);
  await fetchOrClone(git, log, helper, { name: repo.name, dir, url: remote(ref) });
  await configureClone(git, dir, helper, issued.author);
  writePrePushHook(dir, access, repo.default_branch);
  await moveToDefault(git, log, {
    name: repo.name,
    dir,
    defaultBranch: repo.default_branch,
  });

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
 * Clones every team repo the person has a grant on into `<reposDir>/<name>`, or fetches it when it is there, and
 * leaves each clone detached at the fetched default branch.
 * Repos without a grant are never touched. The credentials asked for here only validate the grant and give the
 * commit author: git itself gets its token from the credential helper, at each request.
 * A repo that cannot be prepared is logged and kept with its error, to be tried again with `retry`.
 */
export async function syncRepositories(opts: SyncRepositoriesOptions): Promise<Repositories> {
  const log = opts.log ?? silentLogger;
  const me = opts.team.people.find((p) => p.handle === opts.person);
  const ready: ClonedRepo[] = [];
  const failed = new Map<string, { repo: TeamRepo; unprepared: UnpreparedRepo }>();

  async function attempt(repo: TeamRepo, access: GitMode, ref: Required<RepoRef>) {
    try {
      const cloned = await prepareRepository(opts, repo, access, ref);
      failed.delete(repo.name);
      ready.push(cloned);

      return cloned;
    } catch (e) {
      const error = reason(e);
      log.warn("could not prepare a repository", { repo: repo.name, error });
      const dir = join(opts.reposDir, repo.name);
      failed.set(repo.name, {
        repo,
        unprepared: { name: repo.name, dir, ref, access, kind: repo.kind, error },
      });

      throw new PortError("unavailable", `${repo.name} could not be prepared: ${error}`, {
        cause: e,
      });
    }
  }

  if (me) {
    mkdirSync(opts.reposDir, { recursive: true });
    for (const repo of opts.team.repos) {
      const grant = repoGrant(me, repo);
      if (grant) {
        await attempt(repo, cappedAccess(grant, opts.profile), parseRepoUrl(repo.url)).catch(
          () => undefined,
        );
      }
    }
  }

  return {
    ready,
    unprepared: () => [...failed.values()].map((f) => f.unprepared),
    async retry(name) {
      const done = ready.find((r) => r.name === name);
      if (done) {
        return done;
      }

      const f = failed.get(name);
      if (!f) {
        throw new PortError("not_found", `${name} is not a repository you have a grant on.`);
      }

      return attempt(f.repo, f.unprepared.access, f.unprepared.ref);
    },
  };
}

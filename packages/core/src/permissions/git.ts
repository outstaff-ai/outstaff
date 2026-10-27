import { allow, deny } from "./decision.js";
import { readGlobals } from "./git-globals.js";
import { judgeSubcommand } from "./git-subcommands.js";
import { judgePath, resolvePath } from "./paths.js";
import type { Decision, GitGlobals, GitRepo, Policy, ToolCall } from "./types.js";

/** Subcommands whose `remote:ref` arguments are refspecs, not `rev:path` forms. */
const REMOTE_VERBS = new Set(["push", "fetch", "pull", "ls-remote"]);

export function repoFor(policy: Policy, cwd: string): GitRepo | undefined {
  let best: string | undefined;
  for (const dir of Object.keys(policy.git.repos)) {
    if (
      (cwd === dir || cwd.startsWith(`${dir}/`)) &&
      (best === undefined || dir.length > best.length)
    ) {
      best = dir;
    }
  }

  if (best === undefined) {
    return undefined;
  }

  return {
    dir: best,
    mode: policy.git.repos[best]!,
    defaultBranch: policy.git.defaultBranches[best] ?? "main",
  };
}

/** Decide a git command. `args` are the words after `git`. */
export function evaluateGit(
  policy: Policy,
  args: string[],
  startCwd: string,
  call: ToolCall,
): Decision {
  const globals = readGlobals(policy, args, startCwd);
  if ("effect" in globals) {
    return globals;
  }

  const sub = args[globals.next];
  if (sub === undefined) {
    return allow("git with no subcommand prints its help.", "git.read");
  }

  const repo = repoFor(policy, globals.cwd);
  if (sub === "push" && (!repo || globals.redirected)) {
    return pushOutsideGrants(globals);
  }

  if (!repo) {
    return allow(`git ${sub} outside the granted repositories.`, "git.default");
  }

  const rest = args.slice(globals.next + 1);

  return (
    deniedPathArgument(policy, sub, rest, globals.cwd, repo.dir) ??
    judgeSubcommand({ sub, rest, repo, currentBranch: call.currentBranch })
  );
}

function pushOutsideGrants(globals: GitGlobals): Decision {
  return deny(
    globals.redirected
      ? "git push with --git-dir, --work-tree or another global option cannot be matched to a granted repository."
      : `git push in ${globals.cwd} is outside the repositories granted to this person.`,
    "git.no-repo",
  );
}

/** Paths and rev:path forms must not reach secrets, even via the object store. */
function deniedPathArgument(
  policy: Policy,
  sub: string,
  rest: string[],
  cwd: string,
  repoDir: string,
): Decision | undefined {
  const touched = rest.find(
    (a) =>
      !a.startsWith("-") &&
      pathsOf(policy, sub, a, cwd, repoDir).some(
        (path) => judgePath(policy.paths.read, path) === "denied",
      ),
  );

  return touched === undefined
    ? undefined
    : deny(`git argument ${touched} touches a path that is off limits.`, "paths.read.deny");
}

/** The paths an argument may name: itself, and the path part of a `rev:path` form. */
function pathsOf(policy: Policy, sub: string, a: string, cwd: string, repoDir: string): string[] {
  const paths = [resolvePath(a, cwd, policy.home)];
  const colon = a.indexOf(":");
  if (colon >= 0 && !REMOTE_VERBS.has(sub)) {
    paths.push(resolvePath(a.slice(colon + 1), repoDir, policy.home));
  }

  return paths;
}

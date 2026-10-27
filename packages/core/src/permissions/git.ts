import { allow, deny } from "./decision.js";
import { pushDecision } from "./git-push.js";
import { judgePath, resolvePath } from "./paths.js";
import type { Decision, GitMode, Policy, ToolCall } from "./types.js";

const READ_VERBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "fetch",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "ls-remote",
  "cat-file",
  "merge-base",
  "name-rev",
  "show-ref",
  "diff-tree",
]);

const WRITE_VERBS = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "reset",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "pull",
  "mv",
  "rm",
]);

const SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--paginate", "-p"]);

/** Global options that take their value as the next word. */
const VALUED_GLOBAL = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

/**
 * Config keys that can change where or how a push goes, or skip the hooks that guard it: remotes and URL rewrites,
 * aliases, credential helpers, hooks, the transport and includes of other config files.
 */
const PUSH_KEYS =
  /^(remote\.|url\.|alias\.|credential|core\.(hookspath|sshcommand|gitproxy|askpass|fsmonitor)|push\.|branch\.[^.]+\.(remote|pushremote|merge)$|include|http\.|protocol\.)/i;

export function repoFor(
  policy: Policy,
  cwd: string,
): { dir: string; mode: GitMode; defaultBranch: string } | undefined {
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

function isListingBranch(rest: string[]): boolean {
  if (
    rest.some((a) =>
      [
        "-l",
        "--list",
        "-a",
        "-r",
        "--show-current",
        "-v",
        "-vv",
        "--contains",
        "--merged",
        "--no-merged",
      ].includes(a),
    )
  ) {
    return !rest.some((a) =>
      /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description)/.test(
        a,
      ),
    );
  }

  return rest.every(
    (a) => a.startsWith("-") && !/^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force)/.test(a),
  );
}

/** Decide a git command. `args` are the words after `git`. */
export function evaluateGit(
  policy: Policy,
  args: string[],
  startCwd: string,
  call: ToolCall,
): Decision {
  let cwd = startCwd;
  let redirected = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") {
      const dir = args[++i];
      if (dir === undefined) {
        return deny("git -C needs a directory.", "git.syntax");
      }

      cwd = resolvePath(dir, cwd, policy.home);
    } else if (SAFE_GLOBAL.has(a)) {
      continue;
    } else if (a === "-c" || a.startsWith("--config-env")) {
      const value = a === "-c" ? (args[++i] ?? "") : a.slice(a.indexOf("=") + 1);
      if (PUSH_KEYS.test(value)) {
        return deny(
          `git ${a.split("=")[0]} ${value.split("=")[0]} could redirect a push or skip its hooks.`,
          "git.config-override",
        );
      }
    } else if (a.startsWith("-")) {
      // --git-dir, --work-tree and the like make the repository something other than the directory.
      redirected = true;
      if (VALUED_GLOBAL.has(a)) {
        i++;
      }
    } else {
      break;
    }
  }

  const sub = args[i];
  if (sub === undefined) {
    return allow("git with no subcommand prints its help.", "git.read");
  }

  const rest = args.slice(i + 1);

  const repo = repoFor(policy, cwd);
  if (sub === "push" && (!repo || redirected)) {
    return deny(
      redirected
        ? "git push with --git-dir, --work-tree or another global option cannot be matched to a granted repository."
        : `git push in ${cwd} is outside the repositories granted to this person.`,
      "git.no-repo",
    );
  }

  if (!repo) {
    return allow(`git ${sub} outside the granted repositories.`, "git.default");
  }

  // Paths and rev:path forms must not reach secrets, even via the object store.
  for (const a of rest) {
    if (a.startsWith("-")) {
      continue;
    }

    const candidates = [resolvePath(a, cwd, policy.home)];
    const colon = a.indexOf(":");
    if (colon >= 0 && sub !== "push" && sub !== "fetch" && sub !== "pull" && sub !== "ls-remote") {
      candidates.push(resolvePath(a.slice(colon + 1), repo.dir, policy.home));
    }

    if (candidates.some((c) => judgePath(policy.paths.read, c) === "denied")) {
      return deny(`git argument ${a} touches a path that is off limits.`, "paths.read.deny");
    }
  }

  const needWrite = (what: string): Decision | undefined =>
    repo.mode === "write"
      ? undefined
      : deny(`${what} needs a write grant; this repository is read-only.`, "git.read-only-repo");

  if (READ_VERBS.has(sub)) {
    return allow(`git ${sub} is read-only.`, "git.read");
  }

  if (sub === "branch") {
    if (isListingBranch(rest)) {
      return allow("Listing branches.", "git.read");
    }

    const blocked = needWrite("Changing branches");
    if (blocked) {
      return blocked;
    }

    return allow("Branch management in a write repository.", "git.write");
  }

  if (
    sub === "tag" ||
    sub === "stash" ||
    sub === "worktree" ||
    sub === "remote" ||
    sub === "config"
  ) {
    const first = rest.find((a) => !a.startsWith("-"));
    const readOnly =
      (sub === "tag" && (rest.length === 0 || rest.some((a) => a === "-l" || a === "--list"))) ||
      (sub === "stash" && (first === "list" || first === "show")) ||
      (sub === "worktree" && first === "list") ||
      (sub === "remote" &&
        (first === undefined || ["show", "get-url", "prune", "update"].includes(first))) ||
      (sub === "config" && rest.some((a) => ["--get", "--get-all", "--list", "-l"].includes(a)));

    if (readOnly) {
      return allow(`git ${sub} (read-only form).`, "git.read");
    }

    if (sub === "remote") {
      return deny(`git remote ${first} could redirect a push.`, "git.remote");
    }

    if (sub === "config") {
      const key = rest.find((a) => !a.startsWith("-")) ?? "";
      return PUSH_KEYS.test(key)
        ? deny(`git config ${key} could redirect a push or skip its hooks.`, "git.config")
        : allow(`git config ${key}.`, "git.write");
    }

    const blocked = needWrite(`git ${sub}`);
    return blocked ?? allow(`git ${sub} in a write repository.`, "git.write");
  }

  if (sub === "push") {
    if (repo.mode !== "write") {
      return deny(
        "Pushing needs a write grant; this repository is read-only.",
        "git.read-only-repo",
      );
    }

    return pushDecision(rest, repo, call.currentBranch);
  }

  if (WRITE_VERBS.has(sub)) {
    const blocked = needWrite(`git ${sub}`);
    if (blocked) {
      return blocked;
    }

    return allow(`git ${sub} in a write repository.`, "git.write");
  }

  return allow(`git ${sub}.`, "git.default");
}

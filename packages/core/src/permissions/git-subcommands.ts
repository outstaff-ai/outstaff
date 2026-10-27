import { allow, deny } from "./decision.js";
import { PUSH_KEYS } from "./git-globals.js";
import { pushDecision } from "./git-push.js";
import type { Decision, GitRepo, GitSubcommand } from "./types.js";

/** Whether a subcommand's arguments are one of its read-only forms; `first` is its first non-option word. */
type ReadOnlyForm = (rest: string[], first: string | undefined) => boolean;

type Judge = (cmd: GitSubcommand) => Decision;

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

const BRANCH_LISTING = new Set([
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
]);

const BRANCH_CHANGE =
  /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|--set-upstream-to|-u|--unset-upstream|--edit-description)/;

const BRANCH_CHANGE_SHORT = /^(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force)/;

/** Decides a subcommand inside a granted repository. */
export function judgeSubcommand(cmd: GitSubcommand): Decision {
  if (READ_VERBS.has(cmd.sub)) {
    return allow(`git ${cmd.sub} is read-only.`, "git.read");
  }

  const judge = SUBCOMMANDS.get(cmd.sub);
  if (judge) {
    return judge(cmd);
  }

  return WRITE_VERBS.has(cmd.sub) ? writeInRepo(cmd) : allow(`git ${cmd.sub}.`, "git.default");
}

/** Undefined when the repository is granted for writing; otherwise the denial of `what`. */
function needWrite(repo: GitRepo, what: string): Decision | undefined {
  return repo.mode === "write"
    ? undefined
    : deny(`${what} needs a write grant; this repository is read-only.`, "git.read-only-repo");
}

function writeInRepo(cmd: GitSubcommand): Decision {
  return (
    needWrite(cmd.repo, `git ${cmd.sub}`) ??
    allow(`git ${cmd.sub} in a write repository.`, "git.write")
  );
}

function isListingBranch(rest: string[]): boolean {
  if (rest.some((a) => BRANCH_LISTING.has(a))) {
    return !rest.some((a) => BRANCH_CHANGE.test(a));
  }

  return rest.every((a) => a.startsWith("-") && !BRANCH_CHANGE_SHORT.test(a));
}

function branch(cmd: GitSubcommand): Decision {
  if (isListingBranch(cmd.rest)) {
    return allow("Listing branches.", "git.read");
  }

  return (
    needWrite(cmd.repo, "Changing branches") ??
    allow("Branch management in a write repository.", "git.write")
  );
}

function push(cmd: GitSubcommand): Decision {
  return needWrite(cmd.repo, "Pushing") ?? pushDecision(cmd.rest, cmd.repo, cmd.currentBranch);
}

function config(_cmd: GitSubcommand, first: string | undefined): Decision {
  const key = first ?? "";

  return PUSH_KEYS.test(key)
    ? deny(`git config ${key} could redirect a push or skip its hooks.`, "git.config")
    : allow(`git config ${key}.`, "git.write");
}

/** A subcommand that is allowed in its read-only forms and judged by `otherwise` in the rest. */
function readOnlyForms(
  isReadOnly: ReadOnlyForm,
  otherwise: (cmd: GitSubcommand, first: string | undefined) => Decision,
): Judge {
  return (cmd) => {
    const first = cmd.rest.find((a) => !a.startsWith("-"));

    return isReadOnly(cmd.rest, first)
      ? allow(`git ${cmd.sub} (read-only form).`, "git.read")
      : otherwise(cmd, first);
  };
}

const SUBCOMMANDS = new Map<string, Judge>([
  ["branch", branch],
  ["push", push],
  [
    "tag",
    readOnlyForms(
      (rest) => rest.length === 0 || rest.some((a) => a === "-l" || a === "--list"),
      writeInRepo,
    ),
  ],
  ["stash", readOnlyForms((_rest, first) => first === "list" || first === "show", writeInRepo)],
  ["worktree", readOnlyForms((_rest, first) => first === "list", writeInRepo)],
  [
    "remote",
    readOnlyForms(
      (_rest, first) =>
        first === undefined || ["show", "get-url", "prune", "update"].includes(first),
      (_cmd, first) => deny(`git remote ${first} could redirect a push.`, "git.remote"),
    ),
  ],
  [
    "config",
    readOnlyForms(
      (rest) => rest.some((a) => ["--get", "--get-all", "--list", "-l"].includes(a)),
      config,
    ),
  ],
]);

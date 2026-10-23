import { judgePath, resolvePath } from "./paths.js";
import type { Decision, GitMode, Policy, ToolCall } from "./types.js";

const allow = (reason: string, rule: string): Decision => ({ effect: "allow", reason, rule });
const deny = (reason: string, rule: string): Decision => ({ effect: "deny", reason, rule });
const ask = (reason: string, rule: string): Decision => ({ effect: "ask", reason, rule });

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

const SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks"]);
const DANGEROUS_ANYWHERE = [
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--output",
  "--no-index",
  "--ext-diff",
  "--open-files-in-pager",
];

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

const looksLikeUrl = (s: string) =>
  /:\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s) || s.startsWith("/") || s.startsWith(".");

function stripRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function pushDecision(
  rest: string[],
  repo: { dir: string; defaultBranch: string },
  currentBranch: string | undefined,
): Decision {
  const def = repo.defaultBranch;
  let del = false;
  let forceLease = false;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }

    if (a === "--force" || a === "-f") {
      return deny(
        "Bare force-push is denied; use --force-with-lease on your own branch.",
        "git.push.force",
      );
    }

    if (a === "--mirror" || a === "--all" || a === "--prune") {
      return deny(`${a} could overwrite the default branch.`, "git.push.mirror");
    }

    if (a === "--no-verify") {
      return deny("Skipping hooks is denied.", "git.push.no-verify");
    }

    if (a === "--delete") {
      del = true;
    } else if (a.startsWith("--force-with-lease")) {
      forceLease = true;
    } else if (a === "--force-if-includes") {
      forceLease = true;
    } else if (
      a === "--receive-pack" ||
      a.startsWith("--receive-pack=") ||
      a === "--exec" ||
      a.startsWith("--exec=") ||
      a === "--repo" ||
      a.startsWith("--repo=")
    ) {
      return deny(`${a.split("=")[0]} is denied.`, "git.push.transport");
    } else if (a === "--push-option") {
      i++;
    } else if (a.startsWith("--push-option=")) {
      continue;
    } else if (
      [
        "--set-upstream",
        "--dry-run",
        "--verbose",
        "--quiet",
        "--tags",
        "--follow-tags",
        "--atomic",
        "--progress",
        "--no-progress",
        "--thin",
        "--no-thin",
        "--porcelain",
      ].includes(a)
    ) {
      continue;
    } else if (a.startsWith("--")) {
      return ask(`Unknown push flag ${a}.`, "git.push.unknown-flag");
    } else if (a.startsWith("-") && a.length > 1) {
      if (a === "-o") {
        i++;
        continue;
      }

      for (const ch of a.slice(1)) {
        if (ch === "f") {
          return deny(
            "Bare force-push is denied; use --force-with-lease on your own branch.",
            "git.push.force",
          );
        }

        if (ch === "d") {
          del = true;
        } else if (!"unvq".includes(ch)) {
          return ask(`Unknown push flag ${a}.`, "git.push.unknown-flag");
        }
      }
    } else {
      positionals.push(a);
    }
  }

  const [remote, ...refspecs] = positionals;
  if (remote !== undefined && looksLikeUrl(remote)) {
    return deny("Push only to a configured remote name, not a URL or path.", "git.push.remote");
  }

  const current = currentBranch === undefined ? undefined : stripRef(currentBranch);
  const targets: string[] = [];
  for (const spec of refspecs) {
    if (spec.startsWith("+")) {
      return deny("A +refspec forces the update; it is denied.", "git.push.force");
    }

    if (/[*?[]/.test(spec)) {
      return deny("Refspec patterns are denied.", "git.push.pattern");
    }

    const colon = spec.indexOf(":");
    let dst = colon >= 0 ? spec.slice(colon + 1) : spec;
    const src = colon >= 0 ? spec.slice(0, colon) : spec;
    if (colon >= 0 && dst === "") {
      dst = src;
    } // "feat:" pushes to the same name

    if (colon >= 0 && src === "" && dst !== "") {
      del = true;
    } // ":branch" deletes

    dst = stripRef(dst);
    if (dst === "HEAD") {
      if (current === undefined) {
        continue;
      }

      dst = current;
    }

    targets.push(dst);
  }

  if (
    refspecs.length === 0 ||
    (refspecs.length === 1 && stripRef(refspecs[0]!) === "HEAD" && !refspecs[0]!.includes(":"))
  ) {
    if (current !== undefined) {
      targets.push(current);
    }
  }

  for (const t of targets) {
    if (t === def) {
      return deny(
        del
          ? `Deleting the default branch "${def}" is denied.`
          : `Pushing to the default branch "${def}" is denied; open a pull request.`,
        "git.push.default-branch",
      );
    }
  }

  const known = current !== undefined || refspecs.length > 0;
  return allow(
    `${forceLease ? "Lease push" : "Push"} to a non-default branch${known ? "" : " (current branch unknown to the policy)"}.`,
    forceLease ? "git.push.lease" : "git.push",
  );
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
      return deny("git config overrides on the command line are denied.", "git.config-override");
    } else if (a.startsWith("-")) {
      return deny(`git global option ${a.split("=")[0]} is denied.`, "git.global-option");
    } else {
      break;
    }
  }

  const sub = args[i];
  if (sub === undefined) {
    return ask("No git subcommand.", "git.syntax");
  }

  const rest = args.slice(i + 1);

  const repo = repoFor(policy, cwd);
  if (!repo) {
    return ask(`git in ${cwd} is outside the repositories granted to this person.`, "git.no-repo");
  }

  for (const a of rest) {
    const flag = a.split("=")[0]!;
    if (DANGEROUS_ANYWHERE.includes(flag) || (sub !== "push" && a.startsWith("-O"))) {
      return deny(`git flag ${flag} is denied.`, "git.flag");
    }
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
    if (sub === "fetch" || sub === "ls-remote") {
      const remote = rest.find((a) => !a.startsWith("-"));
      if (remote !== undefined && looksLikeUrl(remote)) {
        return deny("Fetch only from a configured remote name.", "git.remote");
      }
    }

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

    const names = rest.filter((a) => !a.startsWith("-"));
    if (
      rest.some((a) => /^(-d|-D|-m|-M|--delete|--move)/.test(a)) &&
      names.includes(repo.defaultBranch)
    ) {
      return deny(
        `Deleting or renaming the default branch "${repo.defaultBranch}" is denied.`,
        "git.default-branch",
      );
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
      (sub === "remote" && (first === undefined || first === "show" || first === "get-url")) ||
      (sub === "config" && rest.some((a) => ["--get", "--get-all", "--list", "-l"].includes(a)));

    if (readOnly) {
      return allow(`git ${sub} (read-only form).`, "git.read");
    }

    if (sub === "remote" || sub === "config") {
      return ask(`git ${sub} can redirect pushes; it is not covered.`, "git.unsupported");
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

    if (
      sub === "commit" &&
      rest.some((a) => a === "--no-verify" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))
    ) {
      return deny("Skipping commit hooks is denied.", "git.no-verify");
    }

    return allow(`git ${sub} in a write repository.`, "git.write");
  }

  return ask(`git ${sub} is not covered by the policy.`, "git.unsupported");
}

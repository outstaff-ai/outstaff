import { allow, deny } from "./decision.js";
import { readPushArgs } from "./git-push-args.js";
import type { Decision } from "./types.js";

/** Whether the push names a URL or a path where a remote name belongs. */
function isUrlOrPath(remote: string | undefined): boolean {
  if (remote === undefined) {
    return false;
  }

  return (
    /:\/\//.test(remote) ||
    /^[\w.-]+@[\w.-]+:/.test(remote) ||
    remote.startsWith("/") ||
    remote.startsWith(".")
  );
}

function stripRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function pushDecision(
  rest: string[],
  repo: { dir: string; defaultBranch: string },
  currentBranch: string | undefined,
): Decision {
  const args = readPushArgs(rest);
  if ("effect" in args) {
    return args;
  }

  const [remote, ...refspecs] = args.positionals;
  if (isUrlOrPath(remote)) {
    return deny("Push only to a configured remote name, not a URL or path.", "git.push.remote");
  }

  const current = currentBranch === undefined ? undefined : stripRef(currentBranch);
  const pushed = pushTargets(refspecs, current);
  if ("effect" in pushed) {
    return pushed;
  }

  if (pushed.targets.includes(repo.defaultBranch)) {
    return defaultBranchDenied(repo.defaultBranch, args.del || pushed.deletes);
  }

  return allowPush(args.forceLease, current !== undefined || refspecs.length > 0);
}

/** A push to a branch other than the default; `known` is whether the policy knows which branch that is. */
function allowPush(forceLease: boolean, known: boolean): Decision {
  return allow(
    `${forceLease ? "Lease push" : "Push"} to a non-default branch${known ? "" : " (current branch unknown to the policy)"}.`,
    forceLease ? "git.push.lease" : "git.push",
  );
}

function defaultBranchDenied(def: string, deletes: boolean): Decision {
  return deny(
    deletes
      ? `Deleting the default branch "${def}" is denied.`
      : `Pushing to the default branch "${def}" is denied; open a pull request.`,
    "git.push.default-branch",
  );
}

/** The branches the refspecs push to, and whether any of them deletes one; a decision when a refspec is denied. */
function pushTargets(
  refspecs: string[],
  current: string | undefined,
): { targets: string[]; deletes: boolean } | Decision {
  const targets: string[] = [];
  let deletes = false;
  for (const spec of refspecs) {
    const denied = deniedRefspec(spec);
    if (denied) {
      return denied;
    }

    const parsed = parseRefspec(spec);
    deletes ||= parsed.deletes;
    const dst = parsed.dst === "HEAD" ? current : parsed.dst;
    if (dst !== undefined) {
      targets.push(dst);
    }
  }

  if (current !== undefined && pushesCurrentBranch(refspecs)) {
    targets.push(current);
  }

  return { targets, deletes };
}

function deniedRefspec(spec: string): Decision | undefined {
  if (spec.startsWith("+")) {
    return deny("A +refspec forces the update; it is denied.", "git.push.force");
  }

  if (/[*?[]/.test(spec)) {
    return deny("Refspec patterns are denied.", "git.push.pattern");
  }
}

/** The branch a refspec pushes to; "feat:" pushes to the same name and ":branch" deletes it. */
function parseRefspec(spec: string): { dst: string; deletes: boolean } {
  const colon = spec.indexOf(":");
  if (colon < 0) {
    return { dst: stripRef(spec), deletes: false };
  }

  const src = spec.slice(0, colon);
  const dst = spec.slice(colon + 1);

  return { dst: stripRef(dst === "" ? src : dst), deletes: src === "" && dst !== "" };
}

/** No refspec, or a lone `HEAD`, pushes the current branch. */
function pushesCurrentBranch(refspecs: string[]): boolean {
  if (refspecs.length === 0) {
    return true;
  }

  return refspecs.length === 1 && stripRef(refspecs[0]!) === "HEAD" && !refspecs[0]!.includes(":");
}

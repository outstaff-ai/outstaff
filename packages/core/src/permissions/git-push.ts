import { allow, deny } from "./decision.js";
import type { Decision } from "./types.js";

const looksLikeUrl = (s: string) =>
  /:\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s) || s.startsWith("/") || s.startsWith(".");

function stripRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function pushDecision(
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
      return deny(
        `Unknown push flag ${a}; the push rules cannot judge it.`,
        "git.push.unknown-flag",
      );
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
          return deny(
            `Unknown push flag ${a}; the push rules cannot judge it.`,
            "git.push.unknown-flag",
          );
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

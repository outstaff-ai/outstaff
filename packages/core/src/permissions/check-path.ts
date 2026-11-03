import { allow, deny } from "./decision.js";
import { judgePath, resolvePath } from "./paths.js";
import type { Decision, Policy } from "./types.js";

const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export function checkPath(
  policy: Policy,
  access: "read" | "write",
  raw: string,
  cwd: string,
): Decision {
  const abs = resolvePath(raw, cwd, policy.home);
  if (access === "write" && SINKS.has(abs)) {
    return allow("Discarding output.", "paths.write.sink");
  }

  const verdict = judgePath(policy.paths[access], abs);
  if (verdict === "denied") {
    return deny(`${abs} is off limits.`, `paths.${access}.deny`);
  }

  if (verdict === "outside") {
    const hint = access === "write" ? ownerHint(policy, abs) : undefined;
    return deny(
      `${abs} is outside the paths this person may ${access} with the ${access === "write" ? "edit" : "read"} tools.${hint ? ` ${hint}` : ""}`,
      `paths.${access}.outside`,
    );
  }

  return allow(`${abs} is ${access}able.`, `paths.${access}.allow`);
}

/** What a write in another work item's worktree should do instead: the hint of the deepest worktree holding `abs`. */
function ownerHint(policy: Policy, abs: string): string | undefined {
  const owners = (policy.worktrees ?? []).filter(
    (w) => abs === w.root || abs.startsWith(`${w.root}/`),
  );

  return owners.toSorted((a, b) => b.root.length - a.root.length)[0]?.hint;
}

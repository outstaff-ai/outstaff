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
    return deny(
      `${abs} is outside the paths this person may ${access} with the ${access === "write" ? "edit" : "read"} tools.`,
      `paths.${access}.outside`,
    );
  }

  return allow(`${abs} is ${access}able.`, `paths.${access}.allow`);
}

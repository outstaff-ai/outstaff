import { checkPath } from "./check-path.js";
import { allow, deny } from "./decision.js";
import { evaluateShell } from "./evaluate-shell.js";
import { resolvePath } from "./paths.js";
import { holdsSecrets } from "./secrets.js";
import type { Decision, Policy, ToolCall, ToolKind } from "./types.js";

/** Judges a call of one tool kind, from the working directory it resolves to. */
type KindJudge = (policy: Policy, call: ToolCall, cwd: string) => Decision;

/** The reference decision function. Pure: no I/O, no clock. */
export function evaluate(policy: Policy, call: ToolCall): Decision {
  if (policy.tools.deny.includes(call.kind)) {
    return deny(`Tool ${call.kind} is denied.`, "tools.deny");
  }

  if (!policy.tools.allow.includes(call.kind)) {
    return deny(
      `Tool ${call.kind} is not available to the ${policy.profile} profile.`,
      "tools.allow",
    );
  }

  const cwd = resolvePath(call.cwd ?? policy.defaultCwd, policy.defaultCwd, policy.home);

  return KINDS[call.kind](policy, call, cwd);
}

function fileAccess(policy: Policy, call: ToolCall, cwd: string): Decision {
  if (call.path === undefined) {
    return deny("No path given.", "paths.missing");
  }

  return checkPath(policy, call.kind === "read" ? "read" : "write", call.path, cwd);
}

function search(policy: Policy, call: ToolCall, cwd: string): Decision {
  const abs = resolvePath(call.path ?? cwd, cwd, policy.home);
  if (holdsSecrets(policy, abs)) {
    return deny(`Searching ${abs} would read the secrets folder.`, "paths.read.deny");
  }

  return checkPath(policy, "read", abs, cwd);
}

function ost(policy: Policy, call: ToolCall): Decision {
  if (policy.ost && !policy.ost.allow.includes(call.command ?? "")) {
    return deny(
      `The ost verb ${call.command ?? "(unknown)"} is not available to the ${policy.profile} profile.`,
      "ost.verbs",
    );
  }

  return allow("ost is allowed.", "tools.allow");
}

/** The tool publishes files from disk, so every source must be readable by the person. */
function artifact(policy: Policy, call: ToolCall, cwd: string): Decision {
  const sources = [...(call.path === undefined ? [] : [call.path]), ...(call.paths ?? [])];
  const refused = sources
    .map((p) => checkPath(policy, "read", p, cwd))
    .find((d) => d.effect !== "allow");

  return refused ?? allow("artifact is allowed.", "tools.allow");
}

const allowed: KindJudge = (_policy, call) => allow(`${call.kind} is allowed.`, "tools.allow");

const KINDS: Record<ToolKind, KindJudge> = {
  read: fileAccess,
  write: fileAccess,
  edit: fileAccess,
  search,
  shell: (policy, call) => evaluateShell(policy, call),
  ost,
  artifact,
  web_fetch: allowed,
  subagent: allowed,
};

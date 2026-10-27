import { checkPath } from "./check-path.js";
import { allow, deny } from "./decision.js";
import { evaluateShell } from "./evaluate-shell.js";
import { resolvePath } from "./paths.js";
import { holdsSecrets } from "./secrets.js";
import type { Decision, Policy, ToolCall } from "./types.js";

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
  switch (call.kind) {
    case "read":
    case "write":
    case "edit": {
      if (call.path === undefined) {
        return deny("No path given.", "paths.missing");
      }

      return checkPath(policy, call.kind === "read" ? "read" : "write", call.path, cwd);
    }

    case "search": {
      const abs = resolvePath(call.path ?? cwd, cwd, policy.home);
      if (holdsSecrets(policy, abs)) {
        return deny(`Searching ${abs} would read the secrets folder.`, "paths.read.deny");
      }

      return checkPath(policy, "read", abs, cwd);
    }

    case "shell":
      return evaluateShell(policy, call);
    case "ost":
      if (policy.ost && !policy.ost.allow.includes(call.command ?? "")) {
        return deny(
          `The ost verb ${call.command ?? "(unknown)"} is not available to the ${policy.profile} profile.`,
          "ost.verbs",
        );
      }

      return allow("ost is allowed.", "tools.allow");
    case "artifact": {
      // The tool publishes files from disk, so every source must be readable by the person.
      const sources = [...(call.path === undefined ? [] : [call.path]), ...(call.paths ?? [])];
      const refused = sources
        .map((p) => checkPath(policy, "read", p, cwd))
        .find((d) => d.effect !== "allow");

      return refused ?? allow("artifact is allowed.", "tools.allow");
    }

    case "web_fetch":
    case "subagent":
      return allow(`${call.kind} is allowed.`, "tools.allow");
  }
}

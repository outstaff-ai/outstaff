import type { DoctorCheck } from "@outstaff/core";
import type { ToolStatus } from "#/tools/index.js";

/** How the declared tools fared when the agent installed them at start: one check per tool that is unavailable. */
export function toolStatusChecks(tools: ToolStatus[]): DoctorCheck[] {
  if (tools.length === 0) {
    return [];
  }

  const missing = tools.filter((t) => t.state === "unavailable");
  if (missing.length === 0) {
    return [
      {
        name: "Tools install",
        status: "ok",
        detail: `${tools.map((t) => `${t.name}@${t.version}`).join(", ")} installed.`,
      },
    ];
  }

  return missing.map((t) => ({
    name: `Tool ${t.name} installs`,
    status: "fail",
    detail: t.error ?? `${t.name}@${t.version} did not install.`,
    fix: `Check ${t.name}'s version and source under tools in team.yaml (or its toolset), and that the agent can reach the tool sources; then restart the agent.`,
  }));
}

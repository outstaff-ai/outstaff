import { runtimeOf, type AdapterRegistry, type TeamConfig } from "@outstaff/core";
import { StartupError } from "./startup-error.js";

/** The names of the runtime adapters this build carries. */
export function installedRuntimes(registry: AdapterRegistry): string[] {
  return registry.list("runtime").map((d) => d.name);
}

/**
 * The runtime adapter the person runs on (their own `runtime`, else the team's) and its definition. Refuses one this
 * build does not carry, and one that cannot enforce the permission policy.
 */
export function selectRuntime(
  registry: AdapterRegistry,
  team: Pick<TeamConfig, "integrations">,
  me: TeamConfig["people"][number],
) {
  const ref = runtimeOf(team, me);
  const def = registry.get("runtime", ref.adapter);
  if (!def) {
    const carried = installedRuntimes(registry).join(", ") || "none";
    throw new StartupError(
      `${me.handle} runs on the runtime adapter "${ref.adapter}", which is not installed in this build (it carries: ${carried}).`,
    );
  }

  if (!def.capabilities.includes("runtime.permissions")) {
    throw new StartupError(
      `${me.handle} runs on the runtime adapter "${ref.adapter}", which cannot enforce a permission policy (runtime.permissions).`,
    );
  }

  return { ref, def };
}

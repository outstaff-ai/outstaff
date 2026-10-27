import { AdapterRegistry, type TeamConfig } from "@outstaff/core";
import type { AnyDef, Scope } from "#/commands/types.js";
import type { Configured } from "./types.js";

/** Every adapter this build ships, for guides and derived values; loaded on demand to keep other commands fast. */
export async function shippedRegistry(): Promise<AdapterRegistry> {
  const [
    { githubVcs },
    { slackChat },
    { itsaplanTracker },
    { itsaplanKnowledge },
    { claudeAgentSdk },
  ] = await Promise.all([
    import("@outstaff/integration.vcs.github"),
    import("@outstaff/integration.chat.slack"),
    import("@outstaff/integration.tracker.itsaplan"),
    import("@outstaff/integration.knowledge.itsaplan"),
    import("@outstaff/integration.runtime.claude"),
  ]);

  return new AdapterRegistry()
    .register(githubVcs)
    .register(slackChat)
    .register(itsaplanTracker)
    .register(itsaplanKnowledge)
    .register(claudeAgentSdk);
}

export function configuredAdapters(
  team: TeamConfig,
  registry: AdapterRegistry,
  scope: Scope,
): { found: Configured[]; unknown: string[] } {
  const found: Configured[] = [];
  const unknown: string[] = [];
  for (const [port, ref] of Object.entries(team.integrations)) {
    if (!ref || (scope === "office" && port === "runtime")) {
      continue;
    }

    const def = registry.get(port as AnyDef["port"], ref.adapter);
    if (!def) {
      unknown.push(`${port}/${ref.adapter}`);
      continue;
    }

    const { adapter: _adapter, ...options } = ref;
    found.push({ def, options });
  }

  return { found, unknown };
}

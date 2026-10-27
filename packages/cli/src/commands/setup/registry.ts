import { AdapterRegistry } from "@outstaff/core";

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

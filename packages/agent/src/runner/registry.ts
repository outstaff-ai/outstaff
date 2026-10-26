import { AdapterRegistry } from "@outstaff/core";
import { slackChat } from "@outstaff/integration.chat.slack";
import { claudeAgentSdk } from "@outstaff/integration.runtime.claude";
import { itsaplanKnowledge } from "@outstaff/integration.knowledge.itsaplan";
import { itsaplanTracker } from "@outstaff/integration.tracker.itsaplan";
import { githubVcs } from "@outstaff/integration.vcs.github";

/** The adapters installed in the agent image. */
export function agentRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(githubVcs)
    .register(slackChat)
    .register(itsaplanTracker)
    .register(itsaplanKnowledge)
    .register(claudeAgentSdk);
}

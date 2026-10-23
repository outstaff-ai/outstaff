import { AdapterRegistry } from "@outstaff/core";
import { slackChat } from "@outstaff/chat-slack";
import { claudeAgentSdk } from "@outstaff/runtime-agent-sdk";
import { itsaplanKnowledge, itsaplanTracker } from "@outstaff/tracker-itsaplan";
import { githubVcs } from "@outstaff/vcs-github";

/** The adapters installed in the agent image. */
export function agentRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(githubVcs)
    .register(slackChat)
    .register(itsaplanTracker)
    .register(itsaplanKnowledge)
    .register(claudeAgentSdk);
}

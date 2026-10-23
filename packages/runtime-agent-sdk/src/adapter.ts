import { defineAdapter, type SecretSpec } from "@outstaff/core";
import { workdirFiles } from "./layout.js";
import { agentSdkOptions } from "./options.js";
import { createAgentSdkRuntime } from "./runtime.js";

// The operator supplies credentials to the container; outstaff never reads or stores them (decision 0009).
// None is required by outstaff itself, and exactly one way of signing in has to be present.
const secrets: SecretSpec[] = [
  {
    key: "ANTHROPIC_API_KEY",
    description:
      "Anthropic API key. Use this, a cloud provider or a subscription token; the adapter itself never reads it.",
    optional: true,
    where: "Anthropic Console. Give it to the container as an environment variable or secret file.",
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    description:
      "Long-lived subscription token for this container. Use it within the provider's terms.",
    optional: true,
    where: "Run `claude setup-token` on a machine signed in to your own subscription.",
  },
];

export const claudeAgentSdk = defineAdapter({
  port: "runtime",
  name: "claude-agent-sdk",
  capabilities: ["runtime.sessions", "runtime.usage"],
  options: agentSdkOptions,
  secrets: () => secrets,
  workdirLayout: workdirFiles,
  create: (ctx) =>
    createAgentSdkRuntime({
      options: ctx.options,
      log: ctx.log,
      secrets: ctx.secrets,
      scrubKeys: ctx.secretKeys ?? secrets.map((s) => s.key),
    }),
});

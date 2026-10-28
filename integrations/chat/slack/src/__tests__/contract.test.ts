import { chatContract } from "@outstaff/core/contracts";
import { slackChat } from "#/index.js";
import { slackWith } from "./support/harness.js";

// The adapter against a stateful stand-in for Slack's Web API and Socket Mode.
chatContract("slack (fake Slack)", async () => {
  const { fake, chat } = slackWith();
  return { subject: chat, seed: fake.seed, capabilities: slackChat.capabilities };
});

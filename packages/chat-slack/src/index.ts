import { defineAdapter } from "@outstaff/core";
import { createSlackChat } from "./chat.js";
import { slackOptions } from "./options.js";

export { createSlackChat, type SlackDeps } from "./chat.js";
export { slackOptions, type SlackOptions } from "./options.js";
export { toMrkdwn, splitMrkdwn, SLACK_MAX_LENGTH } from "./mrkdwn.js";
export type { SlackWeb, SlackSocket, SlackEvent } from "./api.js";

export const slackChat = defineAdapter({
  port: "chat",
  name: "slack",
  capabilities: ["chat.messages", "chat.history", "chat.agentProfile"],
  options: slackOptions,
  // Each agent has its own Slack app; the office does not talk to Slack.
  secrets: (scope) =>
    scope === "person"
      ? [
          {
            key: "SLACK_BOT_TOKEN",
            description: "Bot User OAuth Token of this person's Slack app (xoxb-...)",
            where: "api.slack.com/apps > the app > OAuth & Permissions",
          },
          {
            key: "SLACK_APP_TOKEN",
            description: "App-level token with connections:write, for Socket Mode (xapp-...)",
            where: "api.slack.com/apps > the app > Basic Information > App-Level Tokens",
          },
          {
            key: "SLACK_BOT_USER_ID",
            description: "Slack member id of this person's bot user",
            where: "Let ost setup --derive look it up (auth.test), or the app's member profile",
            derivable: true,
            optional: true,
          },
        ]
      : [],
  create: (ctx) => createSlackChat(ctx),
});

import { defineAdapter } from "@outstaff/core";
import { createSlackChat } from "./chat.js";
import { doctorSlack } from "./doctor.js";
import { validateSlackIdentities } from "./identities.js";
import { deriveSlack, slackSetupGuide } from "./setup.js";
import { slackOptions } from "./options.js";

export { createSlackChat, type SlackDeps } from "./chat.js";
export { validateSlackIdentities } from "./identities.js";
export { slackOptions, type SlackOptions } from "./options.js";
export { toMrkdwn, splitMrkdwn, SLACK_MAX_LENGTH } from "./mrkdwn.js";
export type { SlackWeb, SlackSocket, SlackEvent } from "./api.js";

export const slackChat = defineAdapter({
  port: "chat",
  name: "slack",
  capabilities: ["chat.messages", "chat.history", "chat.agentProfile"],
  options: slackOptions,
  // Each agent has its own Slack app, and the office has one more (`<team>-outstaff-office`) that only posts and
  // reads history: no app token, since the office never listens.
  secrets: (scope) =>
    scope === "office"
      ? [
          {
            key: "SLACK_OFFICE_BOT_TOKEN",
            description:
              "Bot User OAuth Token of the team's office Slack app (xoxb-...); it posts and reads channel history only",
            where: "api.slack.com/apps > the office app > OAuth & Permissions",
          },
        ]
      : [
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
        ],
  validateIdentities: validateSlackIdentities,
  create: (ctx) => createSlackChat(ctx),
  setupGuide: slackSetupGuide,
  derive: deriveSlack,
  doctor: doctorSlack,
});

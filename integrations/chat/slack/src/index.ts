import { defineAdapter } from "@outstaff/core";
import { createSlackChat } from "./chat.js";
import { doctorSlack } from "./doctor.js";
import { validateSlackIdentities } from "./identities.js";
import { deriveSlack, slackSetupGuide } from "./setup.js";
import { slackOptions } from "./options.js";

export { createSlackChat } from "./chat.js";
export type { SlackDeps, SlackOptions } from "./types.js";
export { validateSlackIdentities } from "./identities.js";
export { slackOptions } from "./options.js";
export { toMrkdwn, splitMrkdwn, SLACK_MAX_LENGTH } from "./mrkdwn.js";
export type { SlackWeb, SlackSocket, SlackEvent } from "./api.js";

export const slackChat = defineAdapter({
  port: "chat",
  name: "slack",
  capabilities: ["chat.messages", "chat.history", "chat.agentProfile", "chat.files"],
  options: slackOptions,
  // Each agent has its own Slack app. The office has one more (`<team>-outstaff-office`), only for mirroring agent
  // questions to `office.channel`: it posts and reads history, with no app token since the office never listens.
  // The office posts to no person, so a team without that channel needs no office app.
  secrets: (scope) =>
    scope === "office"
      ? [
          {
            key: "SLACK_OFFICE_BOT_TOKEN",
            description:
              "Bot User OAuth Token of the team's office Slack app (xoxb-...), used only to mirror agent questions to office.channel; it posts and reads channel history only. Not needed without office.channel",
            where: "api.slack.com/apps > the office app > OAuth & Permissions",
            optional: true,
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

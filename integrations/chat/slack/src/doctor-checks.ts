import type { DoctorCheck } from "@outstaff/core";

/** Socket Mode needs the app-level token; a bot token pasted there is the usual mistake. */
export function appTokenChecks(appToken: string | undefined): DoctorCheck[] {
  if (!appToken) {
    return [];
  }

  if (appToken.startsWith("xapp-")) {
    return [
      {
        key: "SLACK_APP_TOKEN",
        name: "Slack app token",
        status: "ok",
        detail: "SLACK_APP_TOKEN is set, so Socket Mode can connect.",
      },
    ];
  }

  return [
    {
      key: "SLACK_APP_TOKEN",
      name: "Slack app token",
      status: "fail",
      detail:
        "SLACK_APP_TOKEN does not start with xapp-; it looks like a bot token or a copy mistake.",
      fix: "Use the app-level token with connections:write from Basic Information > App-Level Tokens.",
    },
  ];
}

/** Without files:read the bot cannot download what people send; chat itself keeps working. */
export function filesScopeChecks(scopes: string[] | undefined): DoctorCheck[] {
  if (!scopes || scopes.includes("files:read")) {
    return [];
  }

  return [
    {
      key: "SLACK_BOT_TOKEN",
      name: "Slack files scope",
      status: "warn",
      detail:
        "The bot token lacks the files:read scope, so the agent cannot read pictures and files people send it; it only sees their names.",
      fix: "Add files:read under OAuth & Permissions > Bot Token Scopes, then reinstall the app and copy the new bot token.",
    },
  ];
}

/** Whether the person's `identities.chat` names the bot user the token belongs to. */
export function identityCheck(
  handle: string,
  wanted: string | undefined,
  bot: { id: string; name?: string | undefined },
): DoctorCheck {
  if (!wanted) {
    return {
      name: "Slack identity",
      status: "warn",
      detail: `identities.chat is not set for ${handle}, so the office cannot recognise its messages.`,
      fix: `Set identities.chat to ${bot.id} for ${handle} in team.yaml.`,
    };
  }

  if (wanted !== bot.id && wanted !== bot.name) {
    return {
      name: "Slack identity",
      status: "fail",
      detail: `identities.chat is "${wanted}" but the bot token belongs to ${bot.id}.`,
      fix: `Set identities.chat to ${bot.id} for ${handle} in team.yaml, or use the token of the right app.`,
    };
  }

  return { name: "Slack identity", status: "ok", detail: `identities.chat matches ${bot.id}.` };
}

/** A configured SLACK_BOT_USER_ID must match the token's bot user. */
export function botUserIdChecks(configured: string | undefined, botId: string): DoctorCheck[] {
  if (!configured || configured === botId) {
    return [];
  }

  return [
    {
      key: "SLACK_BOT_USER_ID",
      name: "Slack bot user id",
      status: "fail",
      detail: `SLACK_BOT_USER_ID is "${configured}" but the bot token belongs to ${botId}.`,
      fix: "Run `ost setup --derive` after removing the old value, or set it to the id above.",
    },
  ];
}

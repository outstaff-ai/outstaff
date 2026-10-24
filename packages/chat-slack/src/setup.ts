import type { DeriveContext, SecretSource, SetupContext, SetupStep } from "@outstaff/core";

const quote = (s: string) => JSON.stringify(s);

export function slackManifest(name: string, description: string, handle: string): string {
  return `display_information:
  name: ${quote(name)}
  description: ${quote(description)}
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${quote(handle)}
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_home_opened
      - app_mention
      - message.im
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
}

// The office app only posts and reads history: no Socket Mode, no events, no app-level token.
export function slackOfficeManifest(team: string): string {
  return `display_information:
  name: ${quote(`${team}-outstaff-office`)}
  description: ${quote(`Notifications from the ${team} team's office`)}
features:
  bot_user:
    display_name: ${quote(`${team}-outstaff-office`)}
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history
      - channels:history
      - groups:history
      - users:read
settings:
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
}

export function slackSetupGuide(ctx: SetupContext): SetupStep[] {
  const { person, team } = ctx;
  if (ctx.scope === "office") {
    return [
      {
        title: "Create the office's Slack app",
        body: "Go to https://api.slack.com/apps, Create New App > From a manifest, pick the workspace, switch to the YAML tab and paste the manifest. The office only posts and reads history, so the app has no Socket Mode, events or app-level token.",
        manifest: slackOfficeManifest(team.team.name),
      },
      {
        title: "Install the app and copy the bot token",
        body: "Install App > Install to Workspace. Keep the Bot User OAuth Token (`xoxb-...`) from OAuth & Permissions as `SLACK_OFFICE_BOT_TOKEN`. Invite the app to the channels it should post in. Never use an agent's token here.",
      },
    ];
  }

  if (!person) {
    return [];
  }

  return [
    {
      title: `Create ${person.name}'s Slack app`,
      body: "Go to https://api.slack.com/apps, Create New App > From a manifest, pick the workspace, switch to the YAML tab and paste the manifest. It turns on Socket Mode, so the agent connects out and no public URL is needed.",
      manifest: slackManifest(
        person.name,
        `${person.role} on the ${team.team.name} team`,
        person.handle,
      ),
    },
    {
      title: "Create the app-level token",
      body: "Basic Information > App-Level Tokens > Generate Token and Scopes, with the `connections:write` scope. Keep the `xapp-...` token as `SLACK_APP_TOKEN`.",
    },
    {
      title: "Install the app and copy the bot token",
      body: "Install App > Install to Workspace. Keep the Bot User OAuth Token (`xoxb-...`) from OAuth & Permissions as `SLACK_BOT_TOKEN`. `ost setup --derive` fills `SLACK_BOT_USER_ID` from it.",
    },
  ];
}

export async function deriveSlack(
  secrets: SecretSource,
  ctx: DeriveContext,
): Promise<Record<string, string>> {
  const token = secrets.get("SLACK_BOT_TOKEN");
  if (ctx.scope !== "person" || !token || secrets.get("SLACK_BOT_USER_ID")) {
    return {};
  }

  const res = await ctx.fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  const body = (await res.json()) as { ok: boolean; user_id?: string; error?: string };
  if (!body.ok || !body.user_id) {
    ctx.warn(`Slack auth.test failed: ${body.error ?? res.status}`);
    return {};
  }

  return { SLACK_BOT_USER_ID: body.user_id };
}

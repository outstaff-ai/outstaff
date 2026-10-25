# @outstaff/chat-slack

Slack adapter (`chat/slack`) for Outstaff. Each agent chats through its own Slack app over Socket Mode, using the official `@slack/socket-mode` and `@slack/web-api` clients. Capabilities: `chat.messages`, `chat.history`, `chat.agentProfile`.

```yaml
integrations:
  chat:
    adapter: slack # no options
```

## Create the Slack app (one per person)

1. Open <https://api.slack.com/apps>, choose Create New App > From a manifest, pick your workspace and paste the manifest below (change the names).
2. Basic Information > App-Level Tokens > Generate Token and Scopes: name it `socket`, add the scope `connections:write`. Copy the `xapp-` token to `SLACK_APP_TOKEN`.
3. Install App > Install to Workspace. Copy the Bot User OAuth Token (`xoxb-`) to `SLACK_BOT_TOKEN`.
4. Optionally set the app icon (Basic Information > Display Information).

```yaml
display_information:
  name: Sam
  description: Developer on the acme team
features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: sam
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
```

To let an agent read the history of a channel it was mentioned in, add `channels:history` (and `groups:history` for private channels) and subscribe to nothing more; threads in direct messages need only `im:history`.

## Create the office app (one per team)

The office posts notifications and mirrors agent-to-agent questions through its own app, `<team>-outstaff-office`, which posts and reads history only. It has no app-level token or Socket Mode because the office never listens. Install it and copy its Bot User OAuth Token to `SLACK_OFFICE_BOT_TOKEN`. When chat is configured and the key is missing, the office stops at startup naming it.

```yaml
display_information:
  name: acme-outstaff-office
  description: Notifications from the acme team's office
features:
  bot_user:
    display_name: acme-outstaff-office
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
```

## Secrets

`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_BOT_USER_ID` are in the person scope; `SLACK_OFFICE_BOT_TOKEN` is the office scope's only secret.

| Key                      | Meaning                                                  | Derivable                  |
| ------------------------ | -------------------------------------------------------- | -------------------------- |
| `SLACK_BOT_TOKEN`        | Bot User OAuth Token (`xoxb-...`)                        | no                         |
| `SLACK_APP_TOKEN`        | App-level token with `connections:write` (`xapp-`)       | no                         |
| `SLACK_BOT_USER_ID`      | member id of the bot user, to ignore its own echoes      | yes, `auth.test`; optional |
| `SLACK_OFFICE_BOT_TOKEN` | office app's Bot User OAuth Token (`xoxb-`), office only | no                         |

## Trust

The filter runs inside the adapter, so only trusted people reach the office. A message is delivered only when it is a direct message or an `@mention`, and its sender is trusted:

- Messages from bots (including this app) are always ignored.
- When the team lists `humans`, a sender is trusted only if one of their `identities.chat` equals the sender's Slack member id exactly (`U0123ABCD`, case-sensitive). Names and display names are never matched, because any member can change theirs. To find an id: open the person's Slack profile, choose the three-dot menu, then Copy member ID. A value that is not a member id is logged as a warning at startup and matches nobody (`ost validate` has no adapter hook for this yet).
- When `humans` is omitted, a sender is trusted if they are a full workspace member: not a guest (restricted or single-channel), not deactivated, not a bot.
- If Slack cannot tell who the sender is (`users.info` fails), the message is dropped.

Lookups use `users.info` and are cached for ten minutes. Dropped messages are logged at info level and never answered.

## Behaviour

- **Markdown to mrkdwn.** Agents write markdown; the adapter converts bold, italics, strikethrough, links, headings (bold lines), bullet and task lists, quotes and tables (aligned code blocks), keeps code, and escapes `& < >`.
- **Long messages** are split at line breaks under 3,500 characters; a code block cut by the split is closed and reopened. The first part is the thread parent when posting top level; the rest reply to it.
- **Threads.** `post(channel, text, { thread })` replies in a thread; the returned `thread` is the timestamp to reuse. Inbound messages carry `thread` when they were sent in one.
- **Reactions.** `eyes` is `:eyes:`, `done` is `:white_check_mark:`, `error` is `:x:`. Reacting twice is not an error.
- **History.** `history` reads `conversations.history`, or `conversations.replies` for a thread, oldest first.
- **Direct messages.** `openDirect(userId)` calls `conversations.open`.
- **Agent profile.** `setAgentProfile` publishes the profile (name, role, model, status with the active item linked, last active in the viewer's timezone from `users.info` (UTC when unknown), the chat hint, and sections such as the current work) to the user's Home tab with `views.publish`. When the user opens the tab, it republishes the held profile, first asking the agent for a fresh one (`onProfileRequest`) if the held one is older than a minute and the user is trusted.

Errors map to port errors: `message_not_found`, `channel_not_found`, `user_not_found` become `not_found`; missing scope, not in channel and auth failures become `forbidden`; rate limits become `rate_limited` with `retryAfterMs`; everything else is `unavailable`.

## Testing

`createSlackChat(ctx, { web, socket })` takes injectable clients. Tests drive a stateful fake Slack (`src/testing/slack-fake.ts`) through the chat contract kit, plus formatting goldens, splitting and trust cases. The live test (`src/live.test.ts`) is skipped unless `OUTSTAFF_TEST_SLACK_USER` is set with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

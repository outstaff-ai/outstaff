---
title: Slack (chat)
description: Talk to each agent through its own Slack app over Socket Mode.
---

The `slack` chat adapter (`@outstaff/chat-slack`) gives every agent its own Slack app. People send it direct messages or mention it; it replies in threads, reacts while it works, and shows its status on the app's Home tab. It connects out over Socket Mode, so no public URL is needed.

```yaml
integrations:
  chat:
    adapter: slack
```

There are no options. Capabilities: `chat.messages`, `chat.history`, `chat.agentProfile`.

## Set up an app

Create one Slack app per person, from a manifest:

1. Go to [api.slack.com/apps](https://api.slack.com/apps), choose Create New App > From a manifest, and paste the manifest below.
2. Generate an app-level token with the `connections:write` scope and keep it as `SLACK_APP_TOKEN`.
3. Install the app to your workspace and keep the Bot User OAuth Token as `SLACK_BOT_TOKEN`.

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

## Secrets

| Key                 | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| `SLACK_BOT_TOKEN`   | Bot User OAuth Token (`xoxb-...`)                        |
| `SLACK_APP_TOKEN`   | App-level token for Socket Mode (`xapp-...`)             |
| `SLACK_BOT_USER_ID` | The bot's member id. Optional: derived with `auth.test`. |

## Who the agent listens to

The adapter drops everything but direct messages and mentions from trusted people:

- Bots, including the agent's own app, are ignored.
- If the team lists `humans`, a sender is trusted only when a human's `identities.chat` equals the sender's Slack member id exactly (for example `U0123ABCD`). Names are never matched. To find an id, open the person's profile, choose the three-dot menu and Copy member ID.
- If `humans` is omitted, a sender is trusted when they are a full workspace member. Guests (restricted or single-channel) and deactivated accounts are not.

See [trust model](/decisions/0004-trust-model/) for why trust is decided in the adapter.

## What agents see

Agents write markdown. The adapter converts it to Slack's format (bold, links, headings as bold lines, lists, tables as aligned code blocks, code kept) and splits long messages at line breaks. Reactions map `eyes`, `done` and `error` to :eyes:, :white_check_mark: and :x:. The Home tab shows the agent's role, status, current work and any extra sections.

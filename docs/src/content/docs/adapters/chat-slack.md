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

There are no options. Capabilities: `chat.messages`, `chat.history`, `chat.agentProfile`, `chat.files`.

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
      - files:read
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

## Set up the office app (optional)

The office posts to no person. Everything a human reads in chat comes from an agent, as itself: a result, a blocked report, or a message from the PM. The office app, `<team>-outstaff-office`, is only for the one thing the office writes to chat: the mirror of agent-to-agent questions and answers in the team channel (`office.channel` in `team.yaml`). If the team sets no `office.channel`, skip this section: the office has no chat port and needs no chat credentials. The app posts and reads history only: the manifest has no app-level token, Socket Mode or event subscriptions, because the office never listens to chat.

1. Create an app from the manifest below.
2. Install it to your workspace and keep the Bot User OAuth Token as `SLACK_OFFICE_BOT_TOKEN` in the office container.
3. Invite the app to the team channel.

```yaml
display_information:
  name: acme-outstaff-office
  description: Mirrors the acme team's agent questions to a channel
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

If `office.channel` is set and `SLACK_OFFICE_BOT_TOKEN` is missing, the office stops at startup with an error naming the key; it does not run without mirroring. An agent's `SLACK_BOT_TOKEN` is never used in its place.

## Secrets

| Key                      | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`        | Bot User OAuth Token (`xoxb-...`)                                |
| `SLACK_APP_TOKEN`        | App-level token for Socket Mode (`xapp-...`)                     |
| `SLACK_BOT_USER_ID`      | The bot's member id. Optional: derived with `auth.test`.         |
| `SLACK_OFFICE_BOT_TOKEN` | Office container only: bot token of the office app (`xoxb-...`). |

The first three are in each agent's container; the last is only in the office's, and only needed with `office.channel`.

## Pictures and files

A message with pictures or files is a request like any other. The adapter takes the `file_share` and `thread_broadcast` message subtypes and ignores edits, deletes, joins and bot messages. The agent downloads images and text files up to 10 MB with its bot token into the scratch directory of the work item and lists their paths in its prompt, so the model can read them. Other files, and larger ones, are listed by name and type. Files are data from the sender, like the message text, and are deleted with the scratch directory. Earlier messages of the conversation list their files by name.

Downloading needs the `files:read` scope. An app created before it was added must add `files:read` under OAuth & Permissions > Bot Token Scopes, reinstall, and copy the new bot token; without it the agent still answers but only sees the file names. `ost doctor` warns when the bot token lacks the scope.

When the request becomes a ticket, `ost ticket create` attaches the message's files to it if the tracker takes attachments (capability `tracker.attachments`, supported by the Its a Plan adapter), and the ticket description lists them. Otherwise the description lists the files by name and says they stayed in chat. `ost work attach` adds the files to the existing ticket the same way, and `ost ticket attach <key> <path>` attaches a file by path later.

## Checking identities

`ost validate` warns (`identities.chat_not_member_id`) when a `humans[].identities.chat` or `people[].identities.chat` is not a Slack member id, with the file and line. The adapter repeats the check at startup as a backstop.

## Who the agent listens to

The adapter drops everything but direct messages and mentions from trusted people:

- Bots, including the agent's own app, are ignored.
- If the team lists `humans`, a sender is trusted only when a human's `identities.chat` equals the sender's Slack member id exactly (for example `U0123ABCD`). Names are never matched. To find an id, open the person's profile, choose the three-dot menu and Copy member ID.
- If `humans` is omitted, a sender is trusted when they are a full workspace member. Guests (restricted or single-channel) and deactivated accounts are not.

See [trust model](/decisions/0004-trust-model/) for why trust is decided in the adapter.

## What agents see

Agents write markdown. The adapter converts it to Slack's format (bold, links, headings as bold lines, lists, tables as aligned code blocks, code kept) and splits long messages at line breaks. Reactions map `eyes`, `done` and `error` to :eyes:, :white_check_mark: and :x:. The `eyes` reaction is the acknowledgement on Slack; on the code host the agent reacts the same way to the pull request feedback it takes (see [Acknowledgements](/architecture/agent/#acknowledgements)). The Home tab shows the agent's role, model, whether it is working (on what, linked) or idle, when it was last active in the viewer's timezone (UTC when Slack does not tell), its current work grouped by ticket or pull request, and how to talk to it. Opening the tab refreshes it when it is older than a minute. Switch it off with `policies.chat.profile`.

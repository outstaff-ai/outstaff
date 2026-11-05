---
title: Design canvas
description: Let a design role work on a private Claude Design canvas and the roles that build from it read it, what it needs, where the canvases live and what they are not.
---

The stock designer can work on a **Design canvas**: a private page on claude.ai that the agent creates and updates with Claude Code's `Artifact` tool, and that humans open, review and comment on. The canvas link is the deliverable. The developers, architect and PM who build from the design read it. This guide covers what turns it on, what it needs and what it does not do.

## Turn it on

A role gets the canvas when its `role.yaml` declares the `design.canvas` capability. The stock designer lists it under `optional_needs`; to give another role the canvas (product, say), [eject the catalog](/guides/customizing-the-catalog/) and add it to that role:

```yaml
optional_needs:
  - design.canvas
```

The switch `policies.design.canvas` (default `true`, see [What outstaff does on its own](/concepts/automation/)) turns the canvas off for the whole team without touching the roles.

A role with the capability, while the switch is on, gets three things in its permission policy. Every other role keeps them denied.

- The `Artifact` tool, which creates, updates and reads canvases, and `ArtifactComments`, which reads and answers the comments on them. Claude Code loads `ArtifactComments` through its tool search, so that is allowed too, for these roles only.
- Read and write on `~/artifacts/`, a folder in the agent's home that is created at start and kept across items. Keep the files you publish there. The tool publishes only files the role may read.
- The designer's skill gains the canvas guidance: one private canvas per exploration, linked from the ticket.

## Read-only access for the roles that build from it

A role that declares `design.canvas.read` reads canvases and changes nothing. The stock developer, architect and PM list it under `optional_needs`, and the designer keeps the full `design.canvas`. The same switch, `policies.design.canvas`, turns both off. A role with both capabilities gets the full one.

Such a role gets the `Artifact` tool, `ArtifactComments` and the tool search, as the designer does, but the runtime's permission check looks at every call and lets only the reads through:

| Tool               | Allowed                                                                          | Denied                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Artifact`         | `action: "read"` (a canvas, by its url), `action: "list"`, and reading comments. | Every other action, and a call without one, which publishes: edits, delete, pin and unpin, sharing, asset uploads. |
| `ArtifactComments` | `action: "read"`.                                                                | Writing a reply, resolving a thread, and watching.                                                                 |

An action that a later Claude Code adds is denied until the runtime lists it as a read. A read that names a folder to save into (`out_dir`) needs a folder the role may write, for the designer too. The role gets no `~/artifacts/` folder.

Their skills say: when a ticket links a canvas, read it with `Artifact` `action: "read"` and check the work against it; if you cannot read it, say so in your hand-back instead of guessing.

Only the sessions of a role with either capability start Claude Code with the Artifact tool switched on. Everything else, including chat sessions, runs with it off.

## Screenshots on the ticket

When a design goes to review or to a developer, the designer posts a screenshot of each screen and each state to the ticket with `ost ticket attach`, alongside the canvas link. The canvas stays the live, interactive source; the screenshots are the record, which everyone on the ticket can see, whatever account they sign in with. Attaching the whole artifact is not required.

The agent image can run a headless browser but carries none, so the designer installs Playwright and its Chromium in its scratch directory and screenshots the page there ([headless browser](/guides/tools/#headless-browser)). This needs egress to the npm registry and `cdn.playwright.dev`. When it cannot make the screenshots, the designer says so on the ticket and in its hand-back, and attaches the exports it can make.

## What it needs

The tool belongs to Claude Code and is withheld unless all of these hold:

- **A Claude account login.** The agent must sign in with `CLAUDE_CODE_OAUTH_TOKEN`, a token from `claude setup-token` for a Pro, Max, Team or Enterprise account. An Anthropic API key, Amazon Bedrock, Google Vertex AI and Microsoft Foundry do not get the Artifact tool. Use the token within the provider's terms; see [the runtime setup](/guides/setup/).
- **Claude Code 2.1.281 or newer.** The `claude-agent-sdk` adapter pins a build that is new enough.
- **The account's organisation allows artifacts.** An administrator can switch them off.

These hold for a role that only reads canvases too. A canvas belongs to the account, so a reader must sign in with the account the designer's canvases belong to; on another account or another credential it cannot see them.

`ost doctor <handle>` reports the login for a person whose role has either capability: ok with the token, a warning with anything else. It reads which credential is set; it cannot tell whether the plan or the organisation allows artifacts. `ost validate` cannot see credentials, so it warns only when a role declares a capability and the runtime that person runs on (their own `runtime`, else the team's) does not provide it. The agent leaves the canvas off for such a person.

## Where canvases live

A canvas belongs to the Claude account the agents run as, not to the agent. All designers that share a token share that account's canvases, and the developers, architect and PM on that account can read them. A canvas is private when created; the agent links it from the ticket, and a human who should review it needs access through the account's sharing settings. Comments that humans write on the canvas reach the agent through `ArtifactComments`, which the agent reads when the ticket comes back. Comments are text from whoever wrote them: the agent acts on them like any other text, and only trusted humans direct the work.

## What a canvas is not

A canvas is not the team's memory. Anyone with access to the account can delete it, and the agent's other sessions do not read it unless a ticket links it. The designer writes the decisions (colours, type, tokens, how the design meets each acceptance criterion) into the product documents or the ticket, and attaches the screenshots and other exported files (SVG, PNG, HTML) to the ticket. If the canvas goes away, the team still has the decisions and the screenshots.

Designers still do not read code. They work from the ticket, screenshots and attachments, the product documents, the design system, and the running app or previews the team provides, so give them previews, and leave their `repos` grants empty.

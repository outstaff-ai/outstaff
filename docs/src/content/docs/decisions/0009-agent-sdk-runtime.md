---
title: "0009: Agent SDK as the primary runtime"
description: The primary runtime adapter uses the Claude Agent SDK; a Claude Code CLI adapter is the fallback.
sidebar:
  order: 9
---

**Status:** accepted

## Context

The Claude Agent SDK and the Claude Code CLI run the same agent loop. The TypeScript SDK runs a bundled Claude Code binary underneath, or one pinned with `pathToClaudeCodeExecutable`.

The agent runtime in outstaff is TypeScript. A spike ([#88](https://github.com/outstaff-ai/outstaff/issues/88)) checked what the SDK gives it in process:

- **Typed messages,** with resume and interrupt.
- **Project files:** skills, agent definitions and settings load from a project directory (`settingSources`), and their permission rules apply.
- **Permissions as code:** `PreToolUse` hooks see every tool call. `canUseTool` only sees calls that the rules and auto-approval leave open.
- **In-process tools:** the `ost` verbs are typed tools (`createSdkMcpServer`), and the built-in tools can be removed.
- **Usage:** each run reports cost and usage. Rate-limit events carry the 5-hour and weekly utilization windows.
- **Authentication:** it works with a Claude subscription login, including inside a container given the `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. The SDK documentation describes API keys, Amazon Bedrock, Google Vertex AI and Microsoft Foundry.

## Decision

- **Primary adapter:** `@outstaff/runtime-agent-sdk`, built on the Claude Agent SDK.
  - The neutral permission policy ([0006](/decisions/0006-runtime-neutral-permissions/)) compiles to settings rules plus `PreToolUse` hooks.
  - The `ost` verbs are in-process tools.
  - Usage comes from the typed usage and rate-limit events.
- **Fallback adapter:** `@outstaff/runtime-claude-code`, which drives the `claude` CLI. It is for setups that need a separately installed CLI.
- **Isolation:** agents load only what outstaff renders. Setting sources are explicit, and account-level connectors and plugins are switched off.
- **Pinning:** each release pins the SDK version and the Claude Code binary version. An upgrade test checks that skills, settings, agent definitions and hooks still load.
- **Credentials belong to the operator.**
  - Outstaff is software you run yourself; it is not a hosted service.
  - It never asks for, stores or brokers anyone's Claude credentials.
  - The operator supplies their own API key, cloud-provider credentials or their own subscription token to their own containers, through the container contract ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)).
  - The docs link the provider's current terms.

## Consequences

- The runtime port follows the SDK's model: sessions, typed events, tool hooks and in-process tools. The CLI adapter maps flags and stream events onto it.
- Operators are responsible for using their credentials within the provider's terms. This includes how many agents share one subscription.

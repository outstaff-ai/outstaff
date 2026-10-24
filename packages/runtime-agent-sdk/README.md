# @outstaff/runtime-agent-sdk

The primary runtime adapter for Outstaff. It runs agent sessions with the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) and implements the `runtime` port from `@outstaff/core`: run, resume and interrupt sessions, typed events, in-process `ost` tools, permission enforcement and usage windows. See [decision 0009](https://outstaff-ai.github.io/outstaff/decisions/0009-agent-sdk-runtime/).

```yaml
adapters:
  runtime:
    name: claude-agent-sdk
    options:
      model: sonnet
      maxTurns: 60
```

## Options

| Option           | Default                         | Meaning                                                                                          |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `model`          | `sonnet`                        | Model alias or id, used when a run request names none.                                           |
| `claudeCodePath` | the binary bundled with the SDK | Path to a pinned Claude Code binary (`pathToClaudeCodeExecutable`). Authentication is unchanged. |
| `maxTurns`       | none                            | Upper bound on turns per run. A run request's `maxTurns` takes precedence.                       |

The SDK version is pinned exactly in `package.json`. Pin the binary as well when you need a fixed Claude Code version, and re-check that skills, settings, agents and hooks load after every upgrade.

## Credentials

Outstaff needs no credentials of its own for this adapter, and it never reads, stores or logs yours. The operator supplies one way of signing in to each container, through the container contract ([decision 0009](https://outstaff-ai.github.io/outstaff/decisions/0009-agent-sdk-runtime/)):

- `ANTHROPIC_API_KEY` for an Anthropic API key;
- the environment of a cloud provider (Amazon Bedrock, Google Vertex AI or Microsoft Foundry), as described in the SDK documentation;
- `CLAUDE_CODE_OAUTH_TOKEN` for your own subscription (create it with `claude setup-token`).

Both secrets are declared `optional` in the adapter definition so that `ost setup` can describe them. You are responsible for using your credentials within the provider's current terms, including how many agents share one subscription. Only subscription logins report usage windows; with an API key or a cloud provider `probeUsage()` rejects with `unavailable`.

## Environment of the Claude Code process

The agent's shell must not see secrets with `printenv`, so the child environment is built, not inherited:

1. start from the process environment;
2. remove every secret key declared by any registered adapter (the host passes them as `ctx.secretKeys`; `scrubEnv` from `@outstaff/core`), and always `GH_TOKEN` and `GITHUB_TOKEN`: git gets credentials from the `ost git-credential` helper, never the environment;
3. add back only the runtime credential the operator supplied, read through the secret source, so it can come from `/run/secrets/outstaff/<KEY>` or `OUTSTAFF_SECRETS_DIR`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`;
4. set `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The latter makes Claude Code strip credentials from the environment of the Bash tool, hooks and stdio MCP servers. Checked with a live run: a fake `AWS_SECRET_ACCESS_KEY` and `ANTHROPIC_FOUNDRY_API_KEY` given to the process were absent from `printenv` in the Bash tool, while a plain variable was present.

Non-secret provider configuration passes through: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_REGION`, `AWS_PROFILE`, `ANTHROPIC_BEDROCK_BASE_URL`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE` and `ANTHROPIC_FOUNDRY_BASE_URL`. Google Vertex AI has no Claude-specific secret: `GOOGLE_APPLICATION_CREDENTIALS` is a path, passed through, and the credential file it names should live in the secrets directory.

Known limit: the documentation of the scrub flag does not name `CLAUDE_CODE_OAUTH_TOKEN`, so with a subscription token the agent's shell may still see it. Mitigate with the token's scope and egress rules. Sources: [environment variables](https://code.claude.com/docs/en/env-vars.md), [Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock.md), [Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai.md), [Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry.md).

## Isolation

A session loads only what Outstaff rendered into its workdir:

- `settingSources: ["project"]`, so the workdir's `.claude/` (settings, skills, agents, hooks) applies and user or local settings do not;
- `strictMcpConfig`, so no other MCP configuration is read;
- claude.ai account connectors off (`disableClaudeAiConnectors` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the process environment);
- no plugins.

## Tools

`RunRequest.tools` become an in-process MCP server named `ost`, so the model sees them as `mcp__ost__<name>`. Built-in tools are limited to `builtinTools`: `read` is `Read`, `search` is `Grep` and `Glob`, `edit` is `Edit`, `write` is `Write`, `shell` is `Bash`, `web_fetch` is `WebFetch` and `subagent` is `Task` and `Agent`. The list goes to the SDK's `tools` option and everything else known is also in `disallowedTools`. (`allowedTools` is not used: it only auto-approves.) `Skill` and `TodoWrite` are always available, because rendered skills run through `Skill`.

## Permission enforcement

The request's `Policy` is enforced by a `PreToolUse` hook, which sees every call, including calls that settings rules would auto-approve. The hook maps the SDK call to the neutral call and asks `evaluate(policy, call)` from `@outstaff/core`:

| SDK tool                            | Neutral call                                               |
| ----------------------------------- | ---------------------------------------------------------- |
| `Bash`                              | `shell` with `command` and the session's working directory |
| `Read`                              | `read` with `path`                                         |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit` with `path`                                         |
| `Write`                             | `write` with `path`                                        |
| `Grep`, `Glob`                      | `search` with `path`                                       |
| `WebFetch`                          | `web_fetch`                                                |
| `Task`, `Agent`                     | `subagent`                                                 |
| `mcp__ost__*`                       | `ost`                                                      |

Any other tool, including tools of other MCP servers, is denied. Runs are unattended, so `deny` and `ask` both block the call and the decision's reason goes back to the model. `permissionMode` is `dontAsk`, so nothing waits for a human and anything the hook does not allow is denied. Every decision is also emitted as a `tool_call` event.

## Events

| SDK message                 | `RuntimeEvent`                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `system` init               | `started` with the session id                                                                                                    |
| assistant text (main agent) | `text`                                                                                                                           |
| each hook decision          | `tool_call` with `tool`, `input`, `decision`                                                                                     |
| `rate_limit_event`          | `usage` with `five_hour` and `seven_day` windows (parsed defensively; unknown shapes are ignored)                                |
| `result`                    | `finished` with `ok`, `text`, `costUsd`, `error`, and `interrupted` when the signal fired or the SDK reports `aborted_streaming` |

`probeUsage()` runs a minimal session (no tools, one turn, `haiku`) and returns its usage event.

## Tests

`pnpm test` runs the unit tests and the runtime contract kit against a mocked `query`. The live test makes a real call with whatever credentials the environment has:

```sh
OUTSTAFF_TEST_LIVE_SDK=1 pnpm vitest run --project runtime-agent-sdk
```

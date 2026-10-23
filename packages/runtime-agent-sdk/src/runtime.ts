import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  PortError,
  envSecretSource,
  scrubEnv,
  silentLogger,
  type Decision,
  type Logger,
  type RunRequest,
  type Runtime,
  type SecretSource,
  type RuntimeEvent,
  type UsageEvent,
} from "@outstaff/core";
import { mapMessage, type MapState } from "./messages.js";
import type { AgentSdkOptions } from "./options.js";
import { permissionHook } from "./permissions.js";
import { ALWAYS_DROPPED, CREDENTIAL_KEYS } from "./credentials.js";
import { builtinToolNames, disallowedToolNames, OST_SERVER, ostServer } from "./tools.js";
import type { QueryFn } from "./types.js";

export interface AgentSdkRuntimeConfig {
  options: AgentSdkOptions;
  log?: Logger;

  /** Replaces the SDK's `query`; for tests. */
  query?: QueryFn;

  /** Starting point for the Claude Code process environment. Defaults to the process environment. */
  env?: Record<string, string | undefined>;

  /** Where the runtime credential is read from (files first, then `env`). Defaults to `envSecretSource(env)`. */
  secrets?: SecretSource;

  /** Every secret key any adapter declares; removed from the child's environment. */
  scrubKeys?: Iterable<string>;
}

const PROBE_MODEL = "haiku";

export function createAgentSdkRuntime(config: AgentSdkRuntimeConfig): Runtime {
  const query: QueryFn = config.query ?? sdkQuery;
  const log = config.log ?? silentLogger;

  /** Options that every run shares: nothing outside what outstaff renders is loaded. */
  function childEnv(): Record<string, string> {
    const base = config.env ?? process.env;
    const secrets = config.secrets ?? envSecretSource(base);
    // Nothing an adapter declares as a secret reaches the agent's shell. Only the credential Claude Code itself needs goes back in.
    const env = scrubEnv(base, [
      ...(config.scrubKeys ?? []),
      ...CREDENTIAL_KEYS,
      ...ALWAYS_DROPPED,
    ]);

    for (const key of CREDENTIAL_KEYS) {
      const value = secrets.get(key);
      if (value !== undefined) {
        env[key] = value;
      }
    }

    env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false";
    // Claude Code strips its own credentials from the environment of the Bash tool, hooks and stdio MCP servers.
    env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";
    return env;
  }

  function isolated(): Options {
    return {
      settingSources: ["project"],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      env: childEnv(),
      ...(config.options.claudeCodePath
        ? { pathToClaudeCodeExecutable: config.options.claudeCodePath }
        : {}),
    };
  }

  async function* run(req: RunRequest): AsyncGenerator<RuntimeEvent> {
    if (req.signal?.aborted) {
      yield { type: "finished", ok: false, text: "", interrupted: true };
      return;
    }

    const pending: RuntimeEvent[] = [];
    const onDecision = (tool: string, input: unknown, decision: Decision) => {
      log.debug("tool call judged", { tool, effect: decision.effect, rule: decision.rule });
      pending.push({ type: "tool_call", tool, input, decision });
    };

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const maxTurns = req.maxTurns ?? config.options.maxTurns;
    const options: Options = {
      ...isolated(),
      cwd: req.workdir,
      additionalDirectories: req.addDirs,
      systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
      model: req.model ?? config.options.model,
      ...(req.sessionId ? { resume: req.sessionId } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      abortController: abort,
      tools: builtinToolNames(req.builtinTools),
      disallowedTools: disallowedToolNames(req.builtinTools),
      mcpServers: { [OST_SERVER]: ostServer(req.tools, req.workItemId) },
      // The hook allows or denies every call; dontAsk turns anything it leaves open into a denial instead of a prompt.
      permissionMode: "dontAsk",
      hooks: { PreToolUse: [{ hooks: [permissionHook(req.policy, req.workdir, onDecision)] }] },
    };

    const state: MapState = { lastText: "" };
    let finished = false;
    try {
      for await (const m of query({ prompt: req.prompt, options })) {
        const events = mapMessage(m, state, req.signal);
        // Hook decisions for the calls in this message arrive before its results; flush them ahead of the result.
        for (const e of events) {
          if (e.type === "finished") {
            yield* pending.splice(0);
          }

          if (e.type === "finished") {
            finished = true;
          }

          yield e;
        }

        yield* pending.splice(0);
      }
    } catch (e) {
      yield* pending.splice(0);
      if (!finished) {
        finished = true;
        const interrupted = req.signal?.aborted === true;
        yield {
          type: "finished",
          ok: false,
          text: state.lastText,
          ...(interrupted
            ? { interrupted: true }
            : { error: e instanceof Error ? e.message : String(e) }),
        };
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    if (!finished) {
      yield {
        type: "finished",
        ok: false,
        text: state.lastText,
        error: "The session ended without a result.",
      };
    }
  }

  async function probeUsage(): Promise<UsageEvent> {
    let usage: UsageEvent | undefined;
    const options: Options = {
      ...isolated(),
      settingSources: [],
      model: PROBE_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: "dontAsk",
      persistSession: false,
    };

    const state: MapState = { lastText: "" };
    for await (const m of query({ prompt: "Reply with the word ok.", options })) {
      for (const e of mapMessage(m, state)) {
        if (e.type === "usage") {
          usage = e;
        }
      }
    }

    if (!usage) {
      throw new PortError(
        "unavailable",
        "The session reported no usage windows. Only subscription logins report them.",
      );
    }

    return usage;
  }

  return { run, probeUsage };
}

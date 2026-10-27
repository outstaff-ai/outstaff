import { existsSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  PortError,
  envSecretSource,
  scrubEnv,
  silentLogger,
  type Decision,
  type RunRequest,
  type Runtime,
  type RuntimeEvent,
  type UsageEvent,
} from "@outstaff/core";
import { renderedSkillNames } from "./layout.js";
import { mapMessage } from "./messages.js";
import { permissionHook } from "./permissions.js";
import { sessionEvents } from "./run-events.js";
import { ALWAYS_DROPPED, CREDENTIAL_KEYS } from "./credentials.js";
import { builtinToolNames, disallowedToolNames, OST_SERVER, ostServer } from "./tools.js";
import type { AgentSdkRuntimeConfig, MapState, QueryFn } from "./types.js";

const PROBE_MODEL = "haiku";

export function createAgentSdkRuntime(config: AgentSdkRuntimeConfig): Runtime {
  const query: QueryFn = config.query ?? sdkQuery;
  const log = config.log ?? silentLogger;

  /** Options that every run shares: nothing outside what outstaff renders is loaded. */
  function childEnv(canvas: boolean): Record<string, string> {
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
    // CLAUDE.md files in added directories (the repositories and worktrees) are not loaded unless this is set. A client
    // repo's CLAUDE.md is not a convention file, so an inherited value never reaches the session.
    delete env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"];
    // The `sandbox` option decides, not an inherited value. With bubblewrap, Claude Code strips its own credentials
    // from the environment of the Bash tool, hooks and stdio MCP servers, and on Linux runs each command in bubblewrap
    // so it cannot read them from another process either.
    delete env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"];
    if (config.options.sandbox === "bubblewrap") {
      env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";
    }

    // Claude Code withholds the Artifact tool from SDK sessions unless CLAUDE_CODE_ARTIFACT is set. Only a session whose
    // role has the design.canvas capability turns it on; an inherited value of either variable never decides.
    delete env["CLAUDE_CODE_ARTIFACT"];
    delete env["CLAUDE_CODE_DISABLE_ARTIFACT"];
    if (canvas) {
      env["CLAUDE_CODE_ARTIFACT"] = "1";
    } else {
      env["CLAUDE_CODE_DISABLE_ARTIFACT"] = "1";
    }

    return env;
  }

  /**
   * With sandbox: bubblewrap, Claude Code's credential files, hidden from the sandbox its commands run in. The sandbox
   * mounts the whole filesystem read-only, so a mounted secret would otherwise be one `cat` away. Other secret files
   * stay readable: `ost git-credential` runs inside the sandbox and reads the GitHub App keys.
   */
  function credentialFiles(): string[] {
    if (config.options.sandbox !== "bubblewrap") {
      return [];
    }

    const env = config.env ?? process.env;
    const dir = config.secretsDir ?? env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff";
    return CREDENTIAL_KEYS.map((k) => join(dir, k)).filter((p) => existsSync(p));
  }

  function isolated(canvas = false): Options {
    const files = credentialFiles();
    return {
      settingSources: ["project"],
      strictMcpConfig: true,
      settings: {
        // Claude Code's own skills are removed; the `skills` allowlist in run() then limits the rest to the rendered ones.
        disableClaudeAiConnectors: true,
        disableBundledSkills: true,
        enableArtifact: canvas,
        ...(files.length > 0
          ? {
              sandbox: {
                credentials: { files: files.map((path) => ({ path, mode: "deny" as const })) },
              },
            }
          : {}),
      },
      env: childEnv(canvas),
      ...(config.options.claudeCodePath
        ? { pathToClaudeCodeExecutable: config.options.claudeCodePath }
        : {}),
    };
  }

  function runOptions(req: RunRequest, abort: AbortController, pending: RuntimeEvent[]): Options {
    const onDecision = (tool: string, input: unknown, decision: Decision) => {
      log.debug("tool call judged", { tool, effect: decision.effect, rule: decision.rule });
      pending.push({ type: "tool_call", tool, input, decision });
    };

    const maxTurns = req.maxTurns ?? config.options.maxTurns;
    return {
      ...isolated(req.builtinTools.includes("artifact")),
      cwd: req.workdir,
      skills: renderedSkillNames(req.workdir),
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
  }

  async function* run(req: RunRequest): AsyncGenerator<RuntimeEvent> {
    if (req.signal?.aborted) {
      yield { type: "finished", ok: false, text: "", interrupted: true };
      return;
    }

    const pending: RuntimeEvent[] = [];
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const options = runOptions(req, abort, pending);
    const state: MapState = { lastText: "" };
    let finished: boolean;
    try {
      finished = yield* sessionEvents(() => query({ prompt: req.prompt, options }), {
        pending,
        state,
        signal: req.signal,
        resumed: req.sessionId !== undefined,
      });
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

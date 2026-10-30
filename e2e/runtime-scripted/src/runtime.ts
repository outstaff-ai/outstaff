import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  evaluate,
  silentLogger,
  type Decision,
  type Logger,
  type RunRequest,
  type Runtime,
  type RuntimeEvent,
  type ToolCall,
  type UsageEvent,
} from "@outstaff/core";
import { latestChatMessage, parsePrompt, type ItemContext } from "./prompt.js";
import { SCRIPTS, type Action } from "./scripts.js";

const sh = (command: string, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", command],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${command}: ${stderr.trim() || error.message}`))
          : resolve(stdout),
    );
  });

const USAGE: UsageEvent = {
  type: "usage",
  windows: [{ name: "five_hour", utilization: 0.05 }],
};

/** The judged form of an action, so the policy sees what the real runtime's hook would see. */
function callOf(a: Action): ToolCall {
  switch (a.type) {
    case "tool":
      return { kind: "ost", command: a.tool.replaceAll("_", ".") };
    case "shell":
      return { kind: "shell", command: a.command, cwd: a.cwd };
    case "write":
      return { kind: "write", path: a.path };
    case "read":
      return { kind: "read", path: a.path };
    case "gate":
      throw new Error("A gate is not judged by the policy.");
  }
}

const NAMES: Record<Exclude<Action["type"], "tool">, string> = {
  shell: "Bash",
  write: "Write",
  read: "Read",
  gate: "Gate",
};

const nameOf = (a: Action) => (a.type === "tool" ? a.tool : NAMES[a.type]);

/** Holds the round while the driver keeps the gate closed (see e2e/stubs/chat.ts). Open unless it was closed. */
async function waitAtGate(name: string, signal?: AbortSignal): Promise<void> {
  const base = process.env["E2E_STUB_URL"] ?? "http://tracker.acme.example:8081";
  for (let i = 0; i < 300 && !signal?.aborted; i++) {
    const res = await fetch(`${base}/gates/${encodeURIComponent(name)}`);
    if (res.ok && ((await res.json()) as { open: boolean }).open) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

type Step = IteratorResult<Action, string>;

/** One round of a script: the request it answers, the script's steps, and the result of its last step. */
interface Round {
  req: RunRequest;
  tools: Map<string, RunRequest["tools"][number]>;
  steps: AsyncGenerator<Action, string, string>;
  log: Logger;
  last: string;
}

async function runTool(action: Extract<Action, { type: "tool" }>, round: Round): Promise<string> {
  const tool = round.tools.get(action.tool);
  if (!tool) {
    throw new Error(`No tool ${action.tool}.`);
  }

  return tool.handler(
    tool.input.parse(action.input),
    round.req.workItemId ? { workItemId: round.req.workItemId } : {},
  );
}

/** Carries out an allowed action and returns its output. */
async function perform(action: Exclude<Action, { type: "gate" }>, round: Round): Promise<string> {
  switch (action.type) {
    case "tool":
      return runTool(action, round);
    case "shell":
      return sh(action.command, action.cwd);
    case "write":
      mkdirSync(dirname(action.path), { recursive: true });
      writeFileSync(action.path, action.text);
      return "";
    case "read":
      return readFileSync(action.path, "utf8");
  }
}

/** Waits at the gate; undefined when the agent is shutting down meanwhile, after saying the round was interrupted. */
async function* passGate(
  action: Extract<Action, { type: "gate" }>,
  round: Round,
): AsyncGenerator<RuntimeEvent, Step | undefined> {
  await waitAtGate(action.name, round.req.signal);
  // The agent is shutting down: the round stops here, as the real runtime does when it is interrupted.
  if (round.req.signal?.aborted) {
    yield { type: "finished", ok: false, text: round.last, interrupted: true };
    return undefined;
  }

  return await round.steps.next("");
}

/** Judges the action with the policy, runs it when allowed and returns the script's next step. */
async function* playAction(
  action: Action,
  round: Round,
): AsyncGenerator<RuntimeEvent, Step | undefined> {
  if (action.type === "gate") {
    return yield* passGate(action, round);
  }

  const decision: Decision = evaluate(round.req.policy, callOf(action));
  yield { type: "tool_call", tool: nameOf(action), input: action, decision };
  if (decision.effect !== "allow") {
    // Thrown into the script, which may expect it (a step that must be denied); otherwise the script fails.
    return await round.steps.throw(
      new Error(`${nameOf(action)} was denied by the policy: ${decision.reason}`),
    );
  }

  let out: string;
  try {
    out = await perform(action, round);
  } catch (e) {
    // A script may expect a step to fail (a rebase that stops on a conflict).
    round.log.info("step failed", { step: nameOf(action), error: String(e) });
    return await round.steps.throw(e);
  }

  round.last = out;
  return await round.steps.next(out);
}

/** Plays the script to its end and returns its last message; undefined when the round was interrupted. */
async function* playScript(round: Round): AsyncGenerator<RuntimeEvent, string | undefined> {
  let step: Step | undefined = await round.steps.next();
  while (!step.done) {
    step = yield* playAction(step.value, round);
    if (!step) {
      return undefined;
    }
  }

  return step.value;
}

export interface ScriptedConfig {
  log?: Logger;
}

/**
 * Plays the script for the kind of work item instead of asking a model. Every step goes through the same policy
 * check and the same in-process `ost` tools as the real runtime; a denied step fails the run.
 */
export function createScriptedRuntime(config: ScriptedConfig = {}): Runtime {
  const log = config.log ?? silentLogger;
  let sessions = 0;

  // What a model would remember: the conversation of each chat session, which a resumed prompt does not repeat.
  const talks = new Map<string, NonNullable<ItemContext["conversation"]>>();

  /** Keeps the conversation of a chat session, and gives a resumed prompt the one it does not repeat. */
  function recall(session: string, ctx: ItemContext | undefined, prompt: string): void {
    if (ctx?.kind !== "chat") {
      return;
    }

    if (ctx.conversation) {
      talks.set(session, [...ctx.conversation]);
      return;
    }

    const known = talks.get(session);
    const latest = latestChatMessage(prompt);
    if (known && latest) {
      known.push({ from: "human", agent: false, text: latest });
      ctx.conversation = [...known];
    }
  }

  async function* playRound(
    round: Round,
    ctx: ItemContext,
    session: string,
  ): AsyncGenerator<RuntimeEvent> {
    try {
      const text = yield* playScript(round);
      if (text === undefined) {
        return;
      }

      round.last = text;
      if (ctx.kind === "chat") {
        talks.get(session)?.push({ from: "agent", agent: true, text });
      }

      yield { type: "text", text };
      yield { type: "finished", ok: true, text };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.error("the script failed", { error });
      yield { type: "finished", ok: false, text: round.last, error };
    }
  }

  async function* run(req: RunRequest): AsyncGenerator<RuntimeEvent> {
    const session = req.sessionId ?? `scripted-${++sessions}-${Date.now()}`;
    yield { type: "started", sessionId: session };
    yield USAGE;
    // The loop asks for a journal entry in the same session, with no tools and one turn.
    if (req.tools.length === 0) {
      yield {
        type: "finished",
        ok: true,
        text: "Scripted round done; the details are in the pull request and the ticket.",
      };

      return;
    }

    const ctx = parsePrompt(req.prompt);
    recall(session, ctx, req.prompt);
    const script = ctx ? SCRIPTS[ctx.kind] : undefined;
    if (!ctx || !script) {
      yield {
        type: "finished",
        ok: true,
        text: `Nothing scripted for ${ctx?.kind ?? "this prompt"}.`,
      };

      return;
    }

    log.info("running the script", { kind: ctx.kind, ticket: ctx.ticket, pr: ctx.pr });
    yield* playRound(
      {
        req,
        tools: new Map(req.tools.map((t) => [t.name, t])),
        steps: script(ctx),
        log,
        last: "",
      },
      ctx,
      session,
    );
  }

  return { run, probeUsage: async () => structuredClone(USAGE) };
}

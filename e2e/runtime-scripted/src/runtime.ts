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
import { parsePrompt } from "./prompt.js";
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
      return { kind: "ost" };
    case "shell":
      return { kind: "shell", command: a.command, cwd: a.cwd };
    case "write":
      return { kind: "write", path: a.path };
    case "read":
      return { kind: "read", path: a.path };
  }
}

const nameOf = (a: Action) =>
  a.type === "tool" ? a.tool : a.type === "shell" ? "Bash" : a.type === "write" ? "Write" : "Read";

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

  async function* run(req: RunRequest): AsyncGenerator<RuntimeEvent> {
    yield { type: "started", sessionId: req.sessionId ?? `scripted-${++sessions}-${Date.now()}` };
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
    const tools = new Map(req.tools.map((t) => [t.name, t]));
    const steps = script(ctx);
    let last = "";
    try {
      let step = await steps.next();
      while (!step.done) {
        const action = step.value;
        const decision: Decision = evaluate(req.policy, callOf(action));
        yield {
          type: "tool_call",
          tool: nameOf(action),
          input: action,
          decision,
        };

        if (decision.effect !== "allow") {
          throw new Error(
            `${nameOf(action)} was ${decision.effect === "deny" ? "denied" : "not covered"} by the policy: ${decision.reason}`,
          );
        }

        let out = "";
        try {
          if (action.type === "tool") {
            const tool = tools.get(action.tool);
            if (!tool) {
              throw new Error(`No tool ${action.tool}.`);
            }

            out = await tool.handler(
              tool.input.parse(action.input),
              req.workItemId ? { workItemId: req.workItemId } : {},
            );
          } else if (action.type === "shell") {
            out = await sh(action.command, action.cwd);
          } else if (action.type === "write") {
            mkdirSync(dirname(action.path), { recursive: true });
            writeFileSync(action.path, action.text);
          } else {
            out = readFileSync(action.path, "utf8");
          }
        } catch (e) {
          // A script may expect a step to fail (a rebase that stops on a conflict).
          log.info("step failed", { step: nameOf(action), error: String(e) });
          step = await steps.throw(e);
          continue;
        }

        last = out;
        step = await steps.next(out);
      }

      last = step.value;
      yield { type: "text", text: last };
      yield { type: "finished", ok: true, text: last };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.error("the script failed", { error });
      yield { type: "finished", ok: false, text: last, error };
    }
  }

  return { run, probeUsage: async () => structuredClone(USAGE) };
}

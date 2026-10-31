import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError } from "@commander-js/extra-typings";
import { runningVersion } from "@outstaff/core";
import { commands, groupSummaries } from "./commands/index.js";
import type { Context, GlobalOptions } from "./types.js";

const pkgUrl = new URL("../package.json", import.meta.url);
export const version = (JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string }).version;

export function nodeContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    async stdin() {
      let text = "";
      for await (const chunk of process.stdin) {
        text += String(chunk);
      }

      return text;
    },
    ...(process.stdin.isTTY && process.stdout.isTTY
      ? {
          async confirm(question: string) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
            } finally {
              rl.close();
            }
          },
          async ask(question: string, fallback: string) {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return (
                (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""} `)).trim() ||
                fallback
              );
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    gitOrigin(cwd) {
      try {
        return (
          execFileSync("git", ["remote", "get-url", "origin"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() || undefined
        );
      } catch {
        return undefined;
      }
    },
  };
}

export function buildProgram(ctx: Context, setExit: (code: number) => void) {
  const program = new Command("ost")
    .description("Run a team of AI agents like an outsourcing agency.")
    .version(runningVersion(ctx.env, version), "-v, --version", "Print the version.")
    .option(
      "--team <path|git-url>",
      "Team config: a file, a directory, or a git URL with an optional #ref.",
    )
    .option("--json", "Print machine-readable JSON instead of text.")
    .configureOutput({ writeOut: ctx.out, writeErr: ctx.err })
    .exitOverride();

  const groups = new Map<string, Command>();
  const parentOf = (group: string | undefined) => {
    if (!group) {
      return program;
    }

    let g = groups.get(group);
    if (!g) {
      g = program
        .command(group)
        .description(groupSummaries[group] ?? group)
        .exitOverride()
        .configureOutput({ writeOut: ctx.out, writeErr: ctx.err });

      groups.set(group, g as unknown as Command);
    }

    return g;
  };

  for (const def of commands) {
    const cmd = parentOf(def.group)
      .command(def.args ? `${def.name} ${def.args}` : def.name)
      .description(def.summary)
      .exitOverride()
      .configureOutput({ writeOut: ctx.out, writeErr: ctx.err });

    for (const o of def.options) {
      cmd.option(o.flags, o.description);
    }

    cmd.action(async (...args: unknown[]) => {
      const self = args.at(-1) as Command;
      const positional = args
        .slice(0, -2)
        .filter((a) => a !== undefined)
        .flatMap((a) => (Array.isArray(a) ? a.map(String) : [String(a)]));

      setExit(await def.run(ctx, self.optsWithGlobals() as GlobalOptions, positional));
    });
  }

  return program;
}

/** Runs the CLI with `argv` (without node and script) and resolves to the exit code. */
export async function run(argv: string[], ctx: Context): Promise<number> {
  let code = 0;
  const program = buildProgram(ctx, (c) => (code = c));
  if (argv.length === 0) {
    ctx.out(program.helpInformation());
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }

    throw err;
  }

  return code;
}

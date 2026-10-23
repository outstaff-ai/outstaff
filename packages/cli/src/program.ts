import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Command, CommanderError } from "@commander-js/extra-typings";
import { commands } from "./commands/index.js";
import type { Context, GlobalOptions } from "./define.js";

const pkgUrl = new URL("../package.json", import.meta.url);
export const version = (JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string }).version;

export function nodeContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
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
    .version(version, "-v, --version", "Print the version.")
    .option(
      "--team <path|git-url>",
      "Team config: a file, a directory, or a git URL with an optional #ref.",
    )
    .option("--json", "Print machine-readable JSON instead of text.")
    .configureOutput({ writeOut: ctx.out, writeErr: ctx.err })
    .exitOverride();

  for (const def of commands) {
    const cmd = program
      .command(def.args ? `${def.name} ${def.args}` : def.name)
      .description(def.summary)
      .exitOverride()
      .configureOutput({ writeOut: ctx.out, writeErr: ctx.err });

    for (const o of def.options) {
      cmd.option(o.flags, o.description);
    }

    cmd.action(async (...args: unknown[]) => {
      const self = args.at(-1) as Command;
      const positional = args.slice(0, -2).map(String);
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

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createHostCliRunner, hostCliBinDir, whichPast, type ExecProgram } from "@outstaff/agent";
import { defineCommand } from "#/define.js";
import type { Context } from "#/types.js";
import { actingPerson, reportFailure } from "./acting-person.js";

/** Runs the program with this process's standard streams; a signal ends it with 128 plus the signal's number. */
const execInherit: ExecProgram = (file, args, { cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)),
    );
  });

const home = (ctx: Context) => ctx.home ?? ctx.env["HOME"] ?? "";

export const hostCli = defineCommand({
  name: "host-cli",
  summary: "Runs the code host's CLI (gh for GitHub) with a short-lived token for one repository.",
  description:
    "The credential wrapper agents run the code host's CLI through: the agent puts a wrapper named like the CLI first on its PATH, which calls this. It finds the team repository the call acts on (`-R`, else the repository of the working directory), checks the person's grant on it, gets a short-lived token for it from the vcs adapter and runs the real CLI with the token in that one process's environment. Nothing is stored. The permission policy decides which of the CLI's commands an agent may run; the App's permissions are the limit.",
  args: "[args...]",
  options: [],
  examples: ["ost host-cli -- run rerun 1234", "ost host-cli -- pr checks 7 -R acme/shop"],
  exitCodes: [
    "the CLI's own exit code when it ran",
    "1: no team repository, no grant, the CLI is not installed, or the token could not be issued",
  ],
  async run(ctx, options, args) {
    try {
      const { team, person, vcs, profile } = await actingPerson(ctx, options);
      const skip = hostCliBinDir(home(ctx));
      const runner = createHostCliRunner({
        team,
        person,
        vcs,
        profile,
        env: ctx.env,
        origin: ctx.gitOrigin,
        which: ctx.which ?? ((command) => whichPast(command, ctx.env["PATH"], skip)),
        exec: ctx.exec ?? execInherit,
        err: ctx.err,
      });

      return await runner.run(args, ctx.cwd);
    } catch (e) {
      return reportFailure(ctx, e);
    }
  },
});

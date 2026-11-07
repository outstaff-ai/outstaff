import { spawn } from "node:child_process";
import {
  parseRepoUrl,
  repoGrant,
  type EffectiveTool,
  type Logger,
  type Profile,
  type TeamConfig,
  type ToolExtension,
} from "@outstaff/core";
import {
  createHostCliRunner,
  hostCliBinDir,
  teamRepoFor,
  whichPast,
  type ExecProgram,
} from "#/repos/index.js";
import {
  installExtensions,
  type ExtensionStatus,
  type RunExtensionInstall,
  type ToolStatus,
} from "#/tools/index.js";
import type { AgentEnv } from "#/verbs/types.js";
import type { StartupOptions } from "./startup.types.js";

/** An install that hangs (a prompt, a stalled download) must not hold the start forever. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Runs a program with its output collected into `sink`, and resolves to its exit code. */
const collecting =
  (sink: string[]): ExecProgram =>
  (file, args, { cwd, env }) =>
    new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: INSTALL_TIMEOUT_MS,
      });

      child.stdout.on("data", (b: Buffer) => sink.push(b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => sink.push(b.toString("utf8")));
      child.on("error", (e) => {
        sink.push(e.message);
        resolve(127);
      });

      child.on("close", (code) => resolve(code ?? 1));
    });

/**
 * The team repository whose token installs an extension: the extension's own when the team lists it and the person
 * has a grant on it, else the first the person has a grant on. The token carries what the person's App may read.
 */
export function tokenRepo(
  team: Pick<TeamConfig, "repos" | "people">,
  person: string,
  ext: ToolExtension,
): string | undefined {
  const me = team.people.find((p) => p.handle === person);
  if (!me) {
    return undefined;
  }

  const own = teamRepoFor(team, { owner: ext.owner, name: ext.name });
  const repo = own && repoGrant(me, own) ? own : team.repos.find((r) => repoGrant(me, r));
  if (!repo) {
    return undefined;
  }

  const ref = parseRepoUrl(repo.url);
  return `${ref.owner}/${ref.name}`;
}

/** Runs one install through the host CLI runner, with a token minted for that call, and collects what it said. */
function installRunner(
  opts: StartupOptions,
  env: Pick<AgentEnv, "vcs">,
  team: TeamConfig,
  person: string,
  profile: Profile,
): RunExtensionInstall {
  return async (ext, args) => {
    const vcs = env.vcs;
    const repo = tokenRepo(team, person, ext);
    if (!vcs || !repo) {
      return { code: 1, output: `${person} has no grant on a team repository to install it with.` };
    }

    const output: string[] = [];
    const runner = createHostCliRunner({
      team,
      person,
      vcs,
      profile,
      env: opts.env,
      origin: () => undefined,
      which: (command) => whichPast(command, opts.env["PATH"], hostCliBinDir(opts.home)),
      exec: collecting(output),
      err: (text) => output.push(text),
    });

    const code = await runner.run(args, opts.home, repo);
    return { code, output: output.join("") };
  };
}

/**
 * Installs the declared extensions of the tools with the code host's CLI, and adds each tool's extension statuses to
 * its status. A failed extension is logged and reported by `ost doctor`; the agent still starts.
 */
export async function installToolExtensions(
  opts: StartupOptions,
  env: Pick<AgentEnv, "vcs">,
  ctx: { team: TeamConfig; person: string; profile: Profile; log: Logger },
  tools: EffectiveTool[],
  statuses: ToolStatus[],
): Promise<ExtensionStatus[]> {
  if (!tools.some((t) => t.extensions?.length)) {
    return [];
  }

  const extensions = await installExtensions({
    tools,
    cli: env.vcs?.hostCli,
    home: opts.home,
    env: { ...opts.env, HOME: opts.env["HOME"] ?? opts.home },
    run: installRunner(opts, env, ctx.team, ctx.person, ctx.profile),
    log: ctx.log,
  });

  for (const s of statuses) {
    const own = extensions.filter((x) => x.tool === s.name);
    if (own.length > 0) {
      s.extensions = own;
    }
  }

  return extensions;
}

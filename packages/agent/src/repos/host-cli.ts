import {
  PortError,
  parseRepoUrl,
  repoGrant,
  type HostCli,
  type RepoRef,
  type TeamConfig,
} from "@outstaff/core";
import { cappedAccess } from "./access.js";
import type { HostCliRunner, HostCliRunnerOptions } from "./types.js";

type TeamRepo = TeamConfig["repos"][number];

/** The value of `-R`/`--repo` in the arguments, as the code host's CLIs spell it. */
export function repoFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      return undefined;
    }

    if (a === "-R" || a === "--repo") {
      return args[i + 1];
    }

    const joined = /^(?:--repo=|-R=?)(.+)$/.exec(a);
    if (joined) {
      return joined[1];
    }
  }

  return undefined;
}

/** `[HOST/]OWNER/NAME` or a URL, as a repository; the host is left out when the text does not give one. */
function targetOf(text: string): RepoRef | undefined {
  const short = /^([^/:@\s]+)\/([^/:@\s]+?)(?:\.git)?$/.exec(text);
  if (short) {
    return { owner: short[1]!, name: short[2]! };
  }

  try {
    return parseRepoUrl(text);
  } catch {
    return undefined;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The team repository a target names; a target without a host matches on owner and name. */
export function teamRepoFor(
  team: Pick<TeamConfig, "repos">,
  target: RepoRef,
): TeamRepo | undefined {
  return team.repos.find((r) => {
    const ref = parseRepoUrl(r.url);
    return (
      same(ref.owner, target.owner) &&
      same(ref.name, target.name) &&
      (!target.host || same(ref.host, target.host))
    );
  });
}

const NO_REPO = (command: string) =>
  `${command} needs a team repository: run it in a clone or worktree of one, or pass -R <owner>/<name>.`;

const NOT_INSTALLED = (cli: HostCli) =>
  `${cli.command} is not installed. Ask a human to declare it under tools in team.yaml, for example ${cli.command}: { version: "${cli.tool.version}"${cli.tool.source ? `, source: "${cli.tool.source}"` : ""} }.`;

/**
 * The credential wrapper behind `ost host-cli`: runs the code host's CLI (`Vcs.hostCli`) with a short-lived token
 * for the one team repository it acts on (`-R`, else the repository of the working directory), at the access the
 * person's grant and role give. The token is in the environment of that one process only; nothing is stored.
 */
export function createHostCliRunner(opts: HostCliRunnerOptions): HostCliRunner {
  const me = opts.team.people.find((p) => p.handle === opts.person);
  const fail = (message: string) => {
    opts.err(`error    ${message}\n`);
    return 1;
  };

  /** The team repository the call is for, and the person's grant on it. */
  function resolve(command: string, args: string[], cwd: string) {
    const text = repoFlag(args) ?? opts.origin(cwd);
    const target = text === undefined ? undefined : targetOf(text);
    const repo = target && teamRepoFor(opts.team, target);
    if (!repo) {
      throw new PortError("invalid", NO_REPO(command));
    }

    const grant = me && repoGrant(me, repo);
    if (!grant) {
      throw new PortError("forbidden", `${opts.person} has no grant on ${repo.name}.`);
    }

    return { ref: parseRepoUrl(repo.url), access: cappedAccess(grant, opts.profile) };
  }

  return {
    async run(args, cwd) {
      const cli = opts.vcs.hostCli;
      if (!cli) {
        return fail("The team's code host has no CLI for agents.");
      }

      const binary = opts.which(cli.command);
      if (!binary) {
        return fail(NOT_INSTALLED(cli));
      }

      try {
        const { ref, access } = resolve(cli.command, args, cwd);
        const issued = await opts.vcs.credentials(opts.person, ref, access, "cli");
        return await opts.exec(binary, args, {
          cwd,
          env: { ...opts.env, ...cli.env(issued.token, ref) },
        });
      } catch (e) {
        if (e instanceof PortError) {
          return fail(`${e.code}: ${e.message}`);
        }

        throw e;
      }
    },
  };
}

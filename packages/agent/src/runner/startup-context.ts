import {
  envSecretSource,
  formatIssue,
  loadTeamConfig,
  silentLogger,
  teamFor,
} from "@outstaff/core";
import { createOfficeConnection, type OfficeConnection } from "#/office-client/index.js";
import { StartupError, present } from "./startup-error.js";
import type { StartupContext, StartupOptions } from "./startup.types.js";

/** The team config; an invalid one is a startup error. */
async function loadTeam(opts: StartupOptions) {
  const loaded = await loadTeamConfig({
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  if (!loaded.ok) {
    throw new StartupError(
      `The team config is invalid:\n${loaded.issues.map(formatIssue).join("\n")}`,
    );
  }

  return loaded;
}

/** Who the agent is and the team it works for, from the container environment. */
export async function loadStartupContext(opts: StartupOptions): Promise<StartupContext> {
  const log = opts.log ?? silentLogger;
  const person = present(opts.env, "OUTSTAFF_PERSON");
  const secrets = opts.secrets ?? envSecretSource(opts.env);
  const { config: teamFile, source } = await loadTeam(opts);
  const me = teamFile.people.find((p) => p.handle === person);
  if (!me) {
    throw new StartupError(`${person} is not a person of team ${teamFile.team.name}.`);
  }

  // From here on the team is as this person sees it: `integrations.runtime` is the runtime they run on.
  const team = teamFor(teamFile, me);

  return { opts, person, secrets, team, teamDir: source.dir, me, log };
}

/** The connection to the office, unless the caller brought one. */
export function officeConnection({ opts, person, secrets, log }: StartupContext): OfficeConnection {
  return (
    opts.connection ??
    createOfficeConnection({
      url: present(opts.env, "OUTSTAFF_OFFICE_URL"),
      person,
      token: secrets.require("OUTSTAFF_AGENT_TOKEN"),
      agentVersion: opts.agentVersion,
      logger: log,
    })
  );
}

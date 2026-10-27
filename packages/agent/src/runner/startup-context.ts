import { envSecretSource, parseTeamConfig, silentLogger, teamFor } from "@outstaff/core";
import { createOfficeConnection, type OfficeConnection } from "#/office-client/index.js";
import { StartupError, present } from "./startup-error.js";
import { shareTeamFile } from "./team-file.js";
import type { StartupContext, StartupOptions } from "./startup.types.js";

/** Where a team's own image copies its `.outstaff` folder; `catalog.path` of the ejected catalog is relative to it. */
export const DEFAULT_TEAM_DIR = "/opt/outstaff/team/.outstaff";

/** The connection to the office, unless the caller brought one. Only the person, the URL and the token are needed. */
export function officeConnection(opts: StartupOptions): OfficeConnection {
  return (
    opts.connection ??
    createOfficeConnection({
      url: present(opts.env, "OUTSTAFF_OFFICE_URL"),
      person: present(opts.env, "OUTSTAFF_PERSON"),
      token: (opts.secrets ?? envSecretSource(opts.env)).require("OUTSTAFF_AGENT_TOKEN"),
      agentVersion: opts.agentVersion,
      ...(opts.log ? { logger: opts.log } : {}),
    })
  );
}

/** The team config the office sent in its welcome; one that does not validate here is a startup error. */
async function teamFromOffice(connection: OfficeConnection) {
  connection.start();
  await connection.whenConnected();
  const parsed = parseTeamConfig(connection.teamConfig());
  if (!parsed.ok) {
    const issues = parsed.issues.map(
      (i) => `${i.path.join(".") || "(root)"} ${i.code}: ${i.message}`,
    );

    throw new StartupError(`The team config from the office is invalid:\n${issues.join("\n")}`);
  }

  return parsed.config;
}

/** Who the agent is, from the container environment, and the team it works for, from the office. */
export async function loadStartupContext(
  opts: StartupOptions,
  connection: OfficeConnection,
): Promise<StartupContext> {
  const log = opts.log ?? silentLogger;
  const person = present(opts.env, "OUTSTAFF_PERSON");
  const secrets = opts.secrets ?? envSecretSource(opts.env);
  const teamFile = await teamFromOffice(connection);
  const me = teamFile.people.find((p) => p.handle === person);
  if (!me) {
    throw new StartupError(`${person} is not a person of team ${teamFile.team.name}.`);
  }

  const teamDir = opts.teamDir ?? DEFAULT_TEAM_DIR;
  shareTeamFile(opts.env, opts.home, teamFile, teamDir);

  // From here on the team is as this person sees it: `integrations.runtime` is the runtime they run on.
  const team = teamFor(teamFile, me);

  return { opts, person, secrets, team, teamDir, me, log };
}

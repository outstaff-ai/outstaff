import { createAgentEnv, fileOnlySecrets } from "@outstaff/agent";
import {
  formatCatalogIssue,
  formatIssue,
  PortError,
  type Profile,
  type TeamConfig,
} from "@outstaff/core";
import { loadCatalogs } from "#/catalogs.js";
import { loadTeam } from "#/load.js";
import type { Context, GlobalOptions, TeamCatalogs } from "#/types.js";
import type { ActingPerson } from "./acting-person.types.js";
import { Failure, defaultRegistry } from "./verbs.js";

type TeamWithCatalogs = { config: TeamConfig; catalogs: TeamCatalogs };

// Git and the host CLI wrapper start these from the agent's shell, where secrets in the environment are scrubbed.
function actingHandle(ctx: Context): string {
  const person = ctx.env["OUTSTAFF_PERSON"];
  if (!person) {
    throw new Failure("Set OUTSTAFF_PERSON to the handle of the person you act as.");
  }

  return person;
}

async function loadTeamAndCatalogs(
  ctx: Context,
  options: GlobalOptions,
): Promise<TeamWithCatalogs> {
  const loaded = await loadTeam(ctx, options);
  if (!loaded.ok) {
    throw new Failure(loaded.issues.map(formatIssue).join("\n"));
  }

  const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
  if (!found.ok) {
    throw new Failure(found.issues.map(formatCatalogIssue).join("\n"));
  }

  return { config: loaded.config, catalogs: found.catalogs };
}

/** The permission profile of the person's role in the merged catalog. */
function profileOf({ config, catalogs }: TeamWithCatalogs, person: string): Profile {
  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const me = config.people.find((p) => p.handle === person);
  const profile = me && roles[me.role]?.permissions;
  if (!profile) {
    throw new Failure(`${person} is not a person of the team, or has an unknown role.`);
  }

  return profile;
}

/** The person `OUTSTAFF_PERSON` names, with a code host built from secret files only. */
export async function actingPerson(ctx: Context, options: GlobalOptions): Promise<ActingPerson> {
  const person = actingHandle(ctx);
  const team = await loadTeamAndCatalogs(ctx, options);
  const profile = profileOf(team, person);
  const env = await createAgentEnv({
    team: team.config,
    person,
    registry: ctx.registry ?? defaultRegistry(),
    secrets: fileOnlySecrets(ctx.env),
  });

  if (!env.vcs) {
    throw new Failure(env.unavailable?.vcs ?? "The team has no vcs adapter.");
  }

  return { team: env.team, person: env.person, profile, vcs: env.vcs };
}

/** Prints a port or input failure and returns the exit code; rethrows anything else. */
export function reportFailure(ctx: Context, e: unknown): number {
  if (e instanceof PortError) {
    ctx.err(`error    ${e.code}: ${e.message}\n`);
    return 1;
  }

  if (e instanceof Failure) {
    ctx.err(`error    invalid: ${e.message}\n`);
    return 1;
  }

  throw e;
}

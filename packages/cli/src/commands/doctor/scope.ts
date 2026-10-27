import { networkChecks } from "@outstaff/agent";
import {
  configuredAdapters,
  envSecretSource,
  scopeChecks,
  type AdapterRegistry,
  type DoctorCheck,
  type TeamConfig,
} from "@outstaff/core";
import { roleProfile } from "#/catalogs.js";
import type { Context, TeamCatalogs } from "#/types.js";
import type { Scope } from "#/commands/types.js";
import { officeChecks } from "./office.js";
import { toolChecks } from "./tools.js";
import type { ScopeReport, ScopeTarget } from "./types.js";

const CONTAINER_SECRETS_DIR = "/run/secrets/outstaff";

const officeSeenFromOutside: DoctorCheck = {
  name: "Office checks itself",
  status: "warn",
  detail:
    "The office scope checks the secrets and providers visible from here; the running office is not contacted.",
  fix: "Run `ost doctor --via-office` to see what the running office itself sees.",
};

/** The checks only the CLI makes: a person's office handshake, tools and network; for the office, a note when it is checked from outside. */
async function placeChecks(ctx: Context, target: ScopeTarget): Promise<DoctorCheck[]> {
  const { team, handle, person, catalogs, dir, secrets } = target;
  const inContainer = dir === CONTAINER_SECRETS_DIR;
  if (target.scope === "office") {
    return inContainer ? [] : [officeSeenFromOutside];
  }

  const office = await officeChecks(ctx, secrets, handle);
  if (!person) {
    return office;
  }

  return [
    ...office,
    ...(await toolChecks(ctx, team, person, catalogs, inContainer)),
    ...(await networkChecks(ctx, team, person, inContainer)),
  ];
}

export async function checkScope(
  ctx: Context,
  team: TeamConfig,
  handle: string,
  dir: string,
  registry: AdapterRegistry,
  catalogs: TeamCatalogs | undefined,
): Promise<ScopeReport> {
  const scope: Scope = handle === "office" ? "office" : "person";
  const person = scope === "person" ? team.people.find((p) => p.handle === handle) : undefined;
  const secrets = envSecretSource(ctx.env, dir);
  const target: ScopeTarget = { team, handle, scope, person, catalogs, dir, secrets };
  const checks = await scopeChecks({
    team,
    scope,
    ...(person ? { person } : {}),
    adapters: configuredAdapters(team, registry, scope),
    secrets,
    dir,
    handle,
    context: {
      fetch: ctx.fetch ?? fetch,
      now: ctx.now ?? (() => new Date()),
      ...(person ? roleProfile(catalogs, person.role) : {}),
    },
    extra: await placeChecks(ctx, target),
  });

  return { scope: handle, checks };
}

import { envSecretSource, type SecretSource, type TeamConfig } from "@outstaff/core";
import type { Context, TeamCatalogs } from "../../types.js";
import { sections } from "../setup-template.js";
import { configuredAdapters, type shippedRegistry } from "../setup/registry.js";
import type { Scope } from "../types.js";
import { adapterChecks } from "./adapters.js";
import { networkChecks } from "./network.js";
import { officeChecks } from "./office.js";
import { secretChecks } from "./secrets.js";
import { toolChecks } from "./tools.js";
import type { ScopeReport, ScopeTarget } from "./types.js";

const CONTAINER_SECRETS_DIR = "/run/secrets/outstaff";

type Checks = ScopeReport["checks"];

const notShipped = (adapter: string): Checks[number] => ({
  name: `${adapter} not checked`,
  status: "warn",
  detail: `${adapter} is not shipped in this build, so its secrets and setup are not checked.`,
});

const officeSeenFromOutside: Checks[number] = {
  name: "Office checks itself",
  status: "warn",
  detail:
    "The office scope checks the secrets and providers visible from here; the running office is not contacted.",
  fix: "Run `ost doctor office` inside the office container to check what the office itself sees.",
};

/** A person's office handshake, tools and network; for the office, a note when it is checked from outside. */
async function placeChecks(ctx: Context, target: ScopeTarget): Promise<Checks> {
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

/** Backstop: a check must not carry a secret even by accident. */
function scrubSecrets(
  list: ReturnType<typeof sections>,
  secrets: SecretSource,
  checks: Checks,
): Checks {
  const values = list
    .flatMap((s) => s.specs.filter((k) => !k.derivable && !k.key.endsWith("_ID")))
    .map((k) => secrets.get(k.key))
    .filter((v): v is string => v !== undefined && v.length >= 6);

  const scrub = (text: string) => values.reduce((t, v) => t.replaceAll(v, "***"), text);
  return checks.map((c) => ({
    ...c,
    detail: scrub(c.detail),
    ...(c.fix ? { fix: scrub(c.fix) } : {}),
  }));
}

export async function checkScope(
  ctx: Context,
  team: TeamConfig,
  handle: string,
  dir: string,
  registry: Awaited<ReturnType<typeof shippedRegistry>>,
  catalogs: TeamCatalogs | undefined,
): Promise<ScopeReport> {
  const scope: Scope = handle === "office" ? "office" : "person";
  const person = scope === "person" ? team.people.find((p) => p.handle === handle) : undefined;
  const { found, unknown } = configuredAdapters(team, registry, scope);
  const secrets = envSecretSource(ctx.env, dir);
  const list = sections(
    team,
    found.map((f) => f.def),
    scope,
    person,
  );

  const target: ScopeTarget = { team, handle, scope, person, catalogs, dir, secrets };
  const checks: Checks = [
    ...secretChecks(list, secrets, dir, handle),
    ...unknown.map(notShipped),
    ...(await placeChecks(ctx, target)),
    ...(await adapterChecks(ctx, found, target)),
  ];

  return { scope: handle, checks: scrubSecrets(list, secrets, checks) };
}

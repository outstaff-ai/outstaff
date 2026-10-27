import { envSecretSource, type DoctorCheck, type TeamConfig } from "@outstaff/core";
import { roleProfile } from "../../catalogs.js";
import type { Context, TeamCatalogs } from "../../types.js";
import { sections } from "../setup-template.js";
import { configuredAdapters, type shippedRegistry } from "../setup/registry.js";
import type { Scope } from "../types.js";
import { fail } from "./check.js";
import { networkChecks } from "./network.js";
import { officeChecks } from "./office.js";
import { secretChecks } from "./secrets.js";
import { toolChecks } from "./tools.js";
import type { ScopeReport } from "./types.js";

const CONTAINER_SECRETS_DIR = "/run/secrets/outstaff";

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

  const checks: ScopeReport["checks"] = secretChecks(list, secrets, dir, handle);
  for (const u of unknown) {
    checks.push({
      name: `${u} not checked`,
      status: "warn",
      detail: `${u} is not shipped in this build, so its secrets and setup are not checked.`,
    });
  }

  if (scope === "person") {
    checks.push(...(await officeChecks(ctx, secrets, handle)));
    if (person) {
      checks.push(
        ...(await toolChecks(ctx, team, person, catalogs, dir === CONTAINER_SECRETS_DIR)),
        ...(await networkChecks(ctx, team, person, dir === CONTAINER_SECRETS_DIR)),
      );
    }
  } else if (dir !== CONTAINER_SECRETS_DIR) {
    checks.push({
      name: "Office checks itself",
      status: "warn",
      detail:
        "The office scope checks the secrets and providers visible from here; the running office is not contacted.",
      fix: "Run `ost doctor office` inside the office container to check what the office itself sees.",
    });
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { def, options } of found) {
    if (!def.doctor) {
      continue;
    }

    let result: DoctorCheck[];
    try {
      result = await def.doctor(secrets, {
        team,
        scope,
        options,
        ...(person ? { person, ...roleProfile(catalogs, person.role) } : {}),
        fetch: ctx.fetch ?? fetch,
        now: ctx.now ?? (() => new Date()),
        warn: (m) => warnings.push(m),
      });
    } catch (e) {
      result = [
        fail(
          `${def.name} checks`,
          `The checks could not run: ${(e as Error).message}`,
          "Fix the error above and run again.",
        ),
      ];
    }

    for (const c of result) {
      // Tracker and knowledge adapters share one provider; report its answer once.
      const id = JSON.stringify([def.name, c.name, c.detail]);
      if (!seen.has(id)) {
        seen.add(id);
        checks.push({ ...c, adapter: def.name });
      }
    }
  }

  for (const w of warnings) {
    checks.push({ name: "Note", status: "warn", detail: w });
  }

  // Backstop: a check must not carry a secret even by accident.
  const values = list
    .flatMap((s) => s.specs.filter((k) => !k.derivable && !k.key.endsWith("_ID")))
    .map((k) => secrets.get(k.key))
    .filter((v): v is string => v !== undefined && v.length >= 6);

  const scrub = (text: string) => values.reduce((t, v) => t.replaceAll(v, "***"), text);
  return {
    scope: handle,
    checks: checks.map((c) => ({
      ...c,
      detail: scrub(c.detail),
      ...(c.fix ? { fix: scrub(c.fix) } : {}),
    })),
  };
}

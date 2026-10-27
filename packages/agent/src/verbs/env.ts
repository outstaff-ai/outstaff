import { PortError, networkGrants, originOf, silentLogger, type PortName } from "@outstaff/core";
import type { AgentEnv, CreateAgentEnvOptions } from "./types.js";

const PORTS = ["tracker", "knowledge", "vcs", "chat"] as const satisfies readonly PortName[];

/**
 * Builds the ports the verbs use from team.yaml. A port the team does not configure stays unset; one it
 * configures but that cannot be created (adapter not installed, bad options, missing secret) is recorded in
 * `unavailable` so the verb that needs it can say why.
 */
export async function createAgentEnv(opts: CreateAgentEnvOptions): Promise<AgentEnv> {
  const { team, person } = opts;
  if (!team.people.some((p) => p.handle === person)) {
    throw new PortError("not_found", `${person} is not a person of team ${team.team.name}.`);
  }

  const log = opts.log ?? silentLogger;
  const env: AgentEnv = { person, team, log };
  const unavailable: NonNullable<AgentEnv["unavailable"]> = {};

  for (const port of PORTS) {
    const ref = team.integrations[port];
    if (!ref) {
      continue;
    }

    const def = opts.registry.get(port, ref.adapter);
    if (!def) {
      unavailable[port] = `the ${port} adapter "${ref.adapter}" is not installed in this build`;
      continue;
    }

    const skip = def.unavailableFor?.({
      team,
      person: team.people.find((p) => p.handle === person)!,
    });

    if (skip) {
      unavailable[port] = skip;
      continue;
    }

    try {
      const { adapter: _adapter, ...raw } = ref;
      const impl = await def.create({
        options: def.options.parse(raw),
        secrets: opts.secrets,
        team,
        log,
        fetch: opts.fetch ?? fetch,
        now: opts.now ?? (() => new Date()),
      });

      (env as unknown as Record<string, unknown>)[port] = impl;
    } catch (e) {
      unavailable[port] =
        `the ${port} adapter "${ref.adapter}" could not start: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (Object.keys(unavailable).length) {
    env.unavailable = unavailable;
  }

  if (opts.office) {
    env.office = opts.office;
  }

  const me = team.people.find((p) => p.handle === person)!;
  const grants = networkGrants(team, me);
  if (grants.http.length > 0 || grants.adb.length > 0) {
    env.network = {
      http: grants.http.map((g) => {
        const key = g.token;
        return {
          name: g.name,
          origin: originOf(g.url)!,
          ...(key ? { token: () => opts.secrets.require(key) } : {}),
        };
      }),
      adb: grants.adb,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
  }

  return env;
}

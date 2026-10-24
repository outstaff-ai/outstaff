import {
  PortError,
  silentLogger,
  type AdapterRegistry,
  type Logger,
  type PortName,
  type SecretSource,
  type TeamConfig,
} from "@outstaff/core";
import type { OfficeClient } from "./office.js";
import type { AgentEnv } from "./types.js";

export interface CreateAgentEnvOptions {
  team: TeamConfig;

  /** Handle of the person this process runs as. */
  person: string;
  registry: AdapterRegistry;
  secrets: SecretSource;
  office?: OfficeClient;

  log?: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}

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

  return env;
}

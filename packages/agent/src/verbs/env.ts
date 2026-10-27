import {
  PortError,
  networkGrants,
  originOf,
  silentLogger,
  type AdapterDefinition,
  type Logger,
  type PortName,
  type TeamConfig,
} from "@outstaff/core";
import type { AgentEnv, CreateAgentEnvOptions, NetworkAccess } from "./types.js";

const PORTS = ["tracker", "knowledge", "vcs", "chat"] as const satisfies readonly PortName[];

type Port = (typeof PORTS)[number];

type Person = TeamConfig["people"][number];

/** What building one configured port produced: the adapter, or why it is unavailable. */
type PortOutcome = { impl: unknown } | { unavailable: string };

/**
 * Builds the ports the verbs use from team.yaml. A port the team does not configure stays unset; one it
 * configures but that cannot be created (adapter not installed, bad options, missing secret) is recorded in
 * `unavailable` so the verb that needs it can say why.
 */
export async function createAgentEnv(opts: CreateAgentEnvOptions): Promise<AgentEnv> {
  const { team, person } = opts;
  const me = team.people.find((p) => p.handle === person);
  if (!me) {
    throw new PortError("not_found", `${person} is not a person of team ${team.team.name}.`);
  }

  const log = opts.log ?? silentLogger;
  const { ports, unavailable } = await buildPorts(opts, me, log);
  const network = networkAccess(opts, me);
  return {
    person,
    team,
    log,
    ...(ports as Partial<Pick<AgentEnv, Port>>),
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
    ...(opts.office ? { office: opts.office } : {}),
    ...(network ? { network } : {}),
  };
}

/** The adapters of every port the team configures, and why each one that could not be built is unavailable. */
async function buildPorts(
  opts: CreateAgentEnvOptions,
  me: Person,
  log: Logger,
): Promise<{ ports: Partial<Record<Port, unknown>>; unavailable: Partial<Record<Port, string>> }> {
  const ports: Partial<Record<Port, unknown>> = {};
  const unavailable: Partial<Record<Port, string>> = {};
  for (const port of PORTS) {
    const outcome = await buildPort(opts, port, me, log);
    if (outcome && "unavailable" in outcome) {
      unavailable[port] = outcome.unavailable;
    } else if (outcome) {
      ports[port] = outcome.impl;
    }
  }

  return { ports, unavailable };
}

/** Creates the adapter for one port, or `undefined` when the team does not configure that port. */
async function buildPort(
  opts: CreateAgentEnvOptions,
  port: Port,
  me: Person,
  log: Logger,
): Promise<PortOutcome | undefined> {
  const { team } = opts;
  const ref = team.integrations[port];
  if (!ref) {
    return undefined;
  }

  const def = opts.registry.get(port, ref.adapter);
  if (!def) {
    return { unavailable: `the ${port} adapter "${ref.adapter}" is not installed in this build` };
  }

  const skip = def.unavailableFor?.({ team, person: me });
  if (skip) {
    return { unavailable: skip };
  }

  try {
    const { adapter: _adapter, ...raw } = ref;
    return { impl: await startAdapter(def, raw, opts, log) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { unavailable: `the ${port} adapter "${ref.adapter}" could not start: ${why}` };
  }
}

function startAdapter(
  def: AdapterDefinition<PortName, unknown, unknown>,
  raw: unknown,
  opts: CreateAgentEnvOptions,
  log: Logger,
): unknown {
  return def.create({
    options: def.options.parse(raw),
    secrets: opts.secrets,
    team: opts.team,
    log,
    fetch: opts.fetch ?? fetch,
    now: opts.now ?? (() => new Date()),
  });
}

/** The services this person may reach, or `undefined` when they may reach none. */
function networkAccess(opts: CreateAgentEnvOptions, me: Person): NetworkAccess | undefined {
  const grants = networkGrants(opts.team, me);
  if (grants.http.length === 0) {
    return undefined;
  }

  return {
    http: grants.http.map((g) => {
      const key = g.token;
      return {
        name: g.name,
        origin: originOf(g.url)!,
        ...(key ? { token: () => opts.secrets.require(key) } : {}),
      };
    }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
}

import { integrationsFor } from "#/config/runtime-of.js";
import type { TeamConfig } from "#/config/types.js";
import type { DeriveContext, DoctorCheck } from "#/ports/adapter.js";
import type { AdapterRegistry } from "#/ports/define.js";
import type { PortName } from "#/ports/adapter.js";
import { fail } from "./check.js";
import type { ConfiguredAdapter, DoctorScope, ScopeChecksInput, ScopedCheck } from "./types.js";

/**
 * The adapters the team file configures for a scope (the office has no runtime; a person runs on their own runtime,
 * else the team's), and the ones not in `registry`.
 */
export function configuredAdapters(
  team: TeamConfig,
  registry: AdapterRegistry,
  scope: DoctorScope,
  person?: TeamConfig["people"][number],
): { found: ConfiguredAdapter[]; unknown: string[] } {
  const found: ConfiguredAdapter[] = [];
  const unknown: string[] = [];
  for (const [port, ref] of Object.entries(integrationsFor(team, person))) {
    if (!ref || (scope === "office" && port === "runtime")) {
      continue;
    }

    const def = registry.get(port as PortName, ref.adapter);
    if (!def) {
      unknown.push(`${port}/${ref.adapter}`);
      continue;
    }

    const { adapter: _adapter, ...options } = ref;
    found.push({ def, options });
  }

  return { found, unknown };
}

async function runOne(
  { def, options }: ConfiguredAdapter,
  input: ScopeChecksInput,
  warn: (m: string) => void,
): Promise<DoctorCheck[]> {
  const { team, scope, person, secrets, context } = input;
  const ctx: DeriveContext = {
    team,
    scope,
    options,
    ...context,
    warn,
    ...(person ? { person } : {}),
  };

  try {
    return await def.doctor!(secrets, ctx);
  } catch (e) {
    return [
      fail(
        `${def.name} checks`,
        `The checks could not run: ${(e as Error).message}`,
        "Fix the error above and run again.",
      ),
    ];
  }
}

/** Every configured adapter's live checks, each answer once, then the notes the adapters gave. */
export async function adapterChecks(input: ScopeChecksInput): Promise<ScopedCheck[]> {
  const out: ScopedCheck[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const configured of input.adapters.found.filter((f) => f.def.doctor)) {
    const name = configured.def.name;
    for (const c of await runOne(configured, input, (m) => warnings.push(m))) {
      // Tracker and knowledge adapters share one provider; report its answer once.
      const id = JSON.stringify([name, c.name, c.detail]);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ ...c, adapter: name });
      }
    }
  }

  return [...out, ...warnings.map((w) => ({ name: "Note", status: "warn" as const, detail: w }))];
}

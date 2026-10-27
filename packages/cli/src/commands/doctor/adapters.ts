import type { DoctorCheck } from "@outstaff/core";
import { roleProfile } from "#/catalogs.js";
import type { Context } from "#/types.js";
import type { Configured } from "#/commands/setup/types.js";
import { fail } from "./check.js";
import type { ScopeReport, ScopeTarget } from "./types.js";

/** One adapter's own live checks; an adapter that throws gets one failed check instead. */
async function runAdapterDoctor(
  ctx: Context,
  { def, options }: Configured,
  target: ScopeTarget,
  warn: (message: string) => void,
): Promise<DoctorCheck[]> {
  const { team, scope, person, catalogs, secrets } = target;
  try {
    return (
      (await def.doctor?.(secrets, {
        team,
        scope,
        options,
        ...(person ? { person, ...roleProfile(catalogs, person.role) } : {}),
        fetch: ctx.fetch ?? fetch,
        now: ctx.now ?? (() => new Date()),
        warn,
      })) ?? []
    );
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

/** Every configured adapter's checks, each tagged with its adapter, followed by the notes they raised. */
export async function adapterChecks(
  ctx: Context,
  found: readonly Configured[],
  target: ScopeTarget,
): Promise<ScopeReport["checks"]> {
  const checks: ScopeReport["checks"] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const configured of found.filter((f) => f.def.doctor)) {
    const name = configured.def.name;
    for (const c of await runAdapterDoctor(ctx, configured, target, (m) => warnings.push(m))) {
      // Tracker and knowledge adapters share one provider; report its answer once.
      const id = JSON.stringify([name, c.name, c.detail]);
      if (!seen.has(id)) {
        seen.add(id);
        checks.push({ ...c, adapter: name });
      }
    }
  }

  return [
    ...checks,
    ...warnings.map((w) => ({ name: "Note", status: "warn" as const, detail: w })),
  ];
}

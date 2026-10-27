import { adapterChecks } from "./adapters.js";
import { secretChecks } from "./secrets.js";
import { secretSections } from "./specs.js";
import type { ScopeChecksInput, ScopedCheck } from "./types.js";

/**
 * The checks `ost doctor` and the office share for one scope: every required secret is present and its file is
 * private, every configured adapter is shipped, and each adapter's live checks. No check carries a secret value.
 */
export async function scopeChecks(input: ScopeChecksInput): Promise<ScopedCheck[]> {
  const { team, scope, person, secrets, dir, handle } = input;
  const list = secretSections(
    team,
    input.adapters.found.map((f) => f.def),
    scope,
    person,
  );

  const checks: ScopedCheck[] = [
    ...secretChecks(list, secrets, dir, handle, input.fileModes !== false),
    ...input.adapters.unknown.map((u) => ({
      name: `${u} not checked`,
      status: "warn" as const,
      detail: `${u} is not shipped in this build, so its secrets and setup are not checked.`,
    })),
    ...(input.extra ?? []),
    ...(await adapterChecks(input)),
  ];

  // Backstop: a check must not carry a secret even by accident.
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

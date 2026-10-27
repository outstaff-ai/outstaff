import { CAPABILITY_PORT } from "#/capabilities.js";
import type { Capability } from "#/types.js";
import type { ConfigWarning, TeamConfig } from "./types.js";
import { LACKING } from "./lacking.js";
import type { TeamCheck } from "./validate.types.js";
import { WARNING_CODES } from "./warning-codes.js";

export const adapterKey = (port: string, adapter: string) => `${port}/${adapter}`;

/** Needed capabilities are reported apart from the optional ones. */
const LEVELS = [
  { optional: false, code: WARNING_CODES.capabilityMissing },
  { optional: true, code: WARNING_CODES.capabilityOptionalMissing },
] as const;

/** Capabilities the person's roles need, or can use, that no configured integration provides. */
export function missingCapabilities(
  c: TeamCheck,
  person: TeamConfig["people"][number],
  i: number,
): ConfigWarning[] {
  if (!c.adaptersKnown) {
    return [];
  }

  const roleNames = [person.role, ...(person.extends ?? [])];

  return LEVELS.flatMap(({ optional, code }) =>
    unprovidedNeeds(c, roleNames, optional).map(([roleName, cap]) => ({
      path: ["people", i, "role"],
      code,
      message: `Role "${roleName}" ${optional ? "can use" : "needs"} ${cap}, which no configured integration provides.`,
      consequence: `${roleName} ${person.handle} cannot ${LACKING[cap]}: no ${CAPABILITY_PORT[cap]} integration provides ${cap}.`,
    })),
  );
}

/** Each unprovided capability the roles need (or can use, when `optional`) once, with the first role needing it. */
function unprovidedNeeds(
  c: TeamCheck,
  roleNames: string[],
  optional: boolean,
): [string, Capability][] {
  const seen = new Set<Capability>();
  const out: [string, Capability][] = [];
  for (const roleName of roleNames) {
    for (const cap of unprovided(c, roleName, optional)) {
      if (!seen.has(cap)) {
        seen.add(cap);
        out.push([roleName, cap]);
      }
    }
  }

  return out;
}

function unprovided(c: TeamCheck, roleName: string, optional: boolean): Capability[] {
  const needs = c.ctx.roles.get(roleName);
  const caps = (optional ? needs?.optionalNeeds : needs?.needs) ?? [];

  // Runtime capabilities are each person's own, checked against their runtime in validate-runtime.
  return caps.filter((cap) => CAPABILITY_PORT[cap] !== "runtime" && !c.provided.has(cap));
}

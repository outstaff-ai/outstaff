import { networkGrants } from "#/config/network.js";
import type { TeamConfig } from "#/config/types.js";
import type { SecretSpec } from "#/ports/types.js";
import type { AnyAdapterDefinition, DoctorScope, SecretSection } from "./types.js";

/** The office's copy of a person's agent token. */
export const tokenKey = (handle: string) =>
  `OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")}`;

/** Keys the framework itself reads, ahead of the adapters' own. */
export function coreSpecs(
  team: TeamConfig,
  scope: DoctorScope,
  person?: TeamConfig["people"][number],
): SecretSpec[] {
  if (scope === "person") {
    const tokens = person
      ? networkGrants(team, person).http.flatMap((g) =>
          g.token
            ? [
                {
                  key: g.token,
                  description: `Bearer token for the "${g.name}" service (${g.url}), sent by \`ost http\`; the agent never sees it`,
                  where: "The service's own settings, for example a long-lived access token",
                },
              ]
            : [],
        )
      : [];

    return [
      {
        key: "OUTSTAFF_AGENT_TOKEN",
        description:
          "This person's token for the office, the same value the office holds as OUTSTAFF_AGENT_TOKEN_<HANDLE>. Choose a long random value",
        where: "Generate it yourself, for example with `openssl rand -hex 32`",
      },
      ...new Map(tokens.map((t) => [t.key, t])).values(),
    ];
  }

  return team.people.map((p) => ({
    key: tokenKey(p.handle),
    description: `Token that lets ${p.name} (${p.handle}) connect to the office; give the same value to that agent as OUTSTAFF_AGENT_TOKEN`,
    where: "Generate it yourself, for example with `openssl rand -hex 32`",
  }));
}

/** One section per adapter, the same key listed once even when several adapters (tracker and knowledge) share it. */
export function secretSections(
  team: TeamConfig,
  defs: AnyAdapterDefinition[],
  scope: DoctorScope,
  person?: TeamConfig["people"][number],
): SecretSection[] {
  const seen = new Set<string>();
  const out: SecretSection[] = [{ title: "outstaff", specs: coreSpecs(team, scope, person) }];
  for (const s of out[0]!.specs) {
    seen.add(s.key);
  }

  for (const def of defs) {
    const specs = def
      .secrets(scope, person ? { team, person } : undefined)
      .filter((s) => !seen.has(s.key));

    for (const s of specs) {
      seen.add(s.key);
    }

    if (specs.length > 0) {
      out.push({ title: `${def.name} (${def.port})`, specs });
    }
  }

  return out;
}

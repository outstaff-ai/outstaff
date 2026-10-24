import type { TeamConfig } from "./schema.js";
import type { ConfigWarning } from "./validate.js";

type Kind = "vcs" | "tracker" | "chat" | "email";

export type IdentityRef = { path: (string | number)[]; subject: string; value: string };

/** Every `identities.<kind>` value in the team, humans first, with the path where it is written. */
export function identitiesOf(
  team: Pick<TeamConfig, "humans" | "people">,
  kind: Kind,
): { humans: IdentityRef[]; people: IdentityRef[] } {
  const humans = (team.humans ?? []).flatMap((h, i) => {
    const value = (h.identities as Partial<Record<Kind, string>>)[kind];
    return value === undefined
      ? []
      : [{ path: ["humans", i, "identities", kind], subject: h.name, value }];
  });

  const people = team.people.flatMap((p, i) => {
    const value = (p.identities as Partial<Record<Kind, string>> | undefined)?.[kind];
    return value === undefined
      ? []
      : [{ path: ["people", i, "identities", kind], subject: p.handle, value }];
  });

  return { humans, people };
}

/** For adapters: a located warning for one identity. */
export function identityWarning(
  ref: IdentityRef,
  code: string,
  message: string,
  consequence: string,
): ConfigWarning {
  return { path: ref.path, code, message, consequence };
}

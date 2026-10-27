import type { TeamConfig } from "#/config/types.js";
import type { ApproverCandidate } from "./types.js";

const same = (a: string | undefined, b: string) =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `who` may approve a merge under `policies.merge.approvers`: `humans` (any trusted human),
 * `human:<id>` (one human, by any identity in `humans`, or by login when none is listed), `role:<role>` (the
 * agent playing the role) or a handle (an agent, or a human by login). Bots and unknown actors never count.
 */
export function isApprover(
  specs: readonly string[],
  who: ApproverCandidate,
  team: { humans?: TeamConfig["humans"] | undefined },
  personForRole: (role: string) => string | undefined,
): boolean {
  if (who.kind === "automation") {
    return false;
  }

  return specs.some((spec) => admits(spec, who, team, personForRole));
}

/** Whether one approver spec admits `who`. */
function admits(
  spec: string,
  who: ApproverCandidate,
  team: { humans?: TeamConfig["humans"] | undefined },
  personForRole: (role: string) => string | undefined,
): boolean {
  if (spec === "humans") {
    return who.kind === "human" && who.trusted;
  }

  if (spec.startsWith("human:")) {
    return isNamedHuman(spec.slice("human:".length), who, team);
  }

  if (spec.startsWith("role:")) {
    return who.kind === "agent" && personForRole(spec.slice("role:".length)) === who.id;
  }

  return who.kind === "agent" ? who.id === spec : who.trusted && same(spec, who.id);
}

/** `human:<id>`: a trusted human known as `id` by any identity in `humans`, or by login when none is listed. */
function isNamedHuman(
  id: string,
  who: ApproverCandidate,
  team: { humans?: TeamConfig["humans"] | undefined },
): boolean {
  if (who.kind !== "human" || !who.trusted) {
    return false;
  }

  const listed = team.humans?.filter((h) => Object.values(h.identities).some((v) => same(v, id)));

  return listed?.length ? listed.some((h) => same(h.identities.vcs, who.id)) : same(id, who.id);
}

import type { TeamConfig } from "../config/types.js";
import type { Tracker } from "../ports/tracker.js";
import type { ActTarget } from "./types.js";

/**
 * The tracker member id of an act's target: an agent's tracker identity (else its handle); for a human, the member
 * whose id, username or name matches the identity the team file gives, else the identity itself.
 */
export async function trackerMemberOf(
  target: ActTarget,
  team: Pick<TeamConfig, "people">,
  tracker: Pick<Tracker, "members">,
): Promise<string> {
  if (target.kind === "agent") {
    return team.people.find((p) => p.handle === target.id)?.identities?.tracker ?? target.id;
  }

  const wanted = target.id;
  const lower = wanted.toLowerCase();
  const all = await tracker.members();
  const hit =
    all.find((m) => m.id === wanted || m.username === wanted) ??
    all.find((m) => m.name.toLowerCase() === lower);

  return hit?.id ?? wanted;
}

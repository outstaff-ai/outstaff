import type { TeamConfig } from "#/config/types.js";
import type { Member } from "#/ports/tracker.js";
import type { MemberActor } from "./types.js";

/**
 * How the team sees a member of its tracker or knowledge base. An agent of the team is recognized by its
 * `identities.tracker` (as the member's id or username); any other agent account is automation. A human is trusted when
 * `humans` names their tracker identity (as username, name or id), or, without a `humans` list, always.
 */
export function trackerActors(
  team: Pick<TeamConfig, "humans" | "people">,
): (member: Member) => MemberActor {
  const agents = new Map<string, string>();
  for (const p of team.people) {
    if (p.identities?.tracker) {
      agents.set(p.identities.tracker, p.handle);
    }
  }

  const explicit =
    team.humans &&
    new Set(
      team.humans.flatMap((h) =>
        h.identities.tracker ? [h.identities.tracker.toLowerCase()] : [],
      ),
    );

  return (member) => {
    const handle = [member.id, member.username]
      .map((n) => (n === undefined ? undefined : agents.get(n)))
      .find((h) => h !== undefined);

    if (handle !== undefined) {
      return { kind: "agent", id: handle, trusted: false };
    }

    const id = member.username ?? member.id;
    if (member.kind === "agent") {
      return { kind: "automation", id, trusted: false };
    }

    const names = [member.username, member.name, member.id].filter((x) => x !== undefined);
    const trusted = explicit ? names.some((n) => explicit.has(n.toLowerCase())) : true;
    return { kind: "human", id, trusted };
  };
}

/**
 * Whose versions of an agent's notes are used: the agent's own, recognized as in `trackerActors` or by its handle as
 * the member's username, and a trusted human's. Another agent's never are.
 */
export function notesTrust(
  team: Pick<TeamConfig, "humans" | "people">,
  handle: string,
): (author: Member) => boolean {
  const actorOf = trackerActors(team);
  return (author) => {
    const actor = actorOf(author);
    if (actor.kind === "agent") {
      return actor.id === handle;
    }

    // Its own account when the team file names no tracker identity for it.
    return author.username === handle || (actor.kind === "human" && actor.trusted);
  };
}

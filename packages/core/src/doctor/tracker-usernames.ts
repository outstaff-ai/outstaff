import type { TeamConfig } from "#/config/types.js";
import type { DoctorCheck } from "#/ports/adapter.js";
import type { Member, Tracker } from "#/ports/tracker.js";

const FIX =
  "Give the member a username in the tracker, and set identities.tracker to the member's id or username.";

/** Whether the tracker has a username for one agent of the team file, so `@username` in a comment mentions it. */
function usernameCheck(handle: string, identity: string, members: readonly Member[]): DoctorCheck {
  const name = `Tracker username of ${handle}`;
  const member = members.find((m) => m.id === identity || m.username === identity);
  if (member?.username) {
    return { name, status: "ok", detail: `${handle} is @${member.username} on the tracker.` };
  }

  return {
    name,
    status: "warn",
    detail: member
      ? `The tracker has no username for ${handle} (member ${member.id}), so a mention of ${handle} by username is not recognised.`
      : `No tracker member is "${identity}" (identities.tracker of ${handle}), so a mention of ${handle} by username is not recognised.`,
    fix: FIX,
  };
}

/**
 * For each agent with a tracker identity: whether the tracker's members have a username for it, which the office
 * matches `@mentions` in comments against. Members that cannot be read leave the usernames not checked, saying why.
 */
export async function trackerUsernameChecks(
  config: Pick<TeamConfig, "people">,
  tracker: Pick<Tracker, "members"> | undefined,
): Promise<DoctorCheck[]> {
  const people = config.people.flatMap((p) =>
    p.identities?.tracker ? [{ handle: p.handle, identity: p.identities.tracker }] : [],
  );

  if (!tracker || people.length === 0) {
    return [];
  }

  try {
    const members = await tracker.members();
    return people.map((p) => usernameCheck(p.handle, p.identity, members));
  } catch (e) {
    return [
      {
        name: "Tracker usernames not checked",
        status: "warn",
        detail: `The tracker's members could not be read: ${(e as Error).message}`,
        fix: "Run the doctor again once that is fixed; until then, a mention of an agent by its tracker username may not be recognised.",
      },
    ];
  }
}

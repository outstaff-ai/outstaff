import {
  WARNING_CODES,
  identitiesOf,
  identityWarning,
  type ConfigWarning,
  type TeamConfig,
} from "@outstaff/core";

/** A Slack member id, never a name or display name. */
export const MEMBER_ID = /^[UW][A-Z0-9]{8,}$/;

/** `humans[].identities.chat` and `people[].identities.chat` must be Slack member ids. */
export function validateSlackIdentities(team: TeamConfig): ConfigWarning[] {
  const { humans, people } = identitiesOf(team, "chat");
  return [...humans, ...people]
    .filter((ref) => !MEMBER_ID.test(ref.value))
    .map((ref) =>
      identityWarning(
        ref,
        WARNING_CODES.identityChatNotMemberId,
        `"${ref.value}" is not a Slack member id (for example U0123ABCD).`,
        `${ref.subject} will not be recognized or reachable in Slack; use the member id (Profile > ... > Copy member ID), not a name.`,
      ),
    );
}

import {
  WARNING_CODES,
  identitiesOf,
  identityWarning,
  type ConfigWarning,
  type TeamConfig,
} from "@outstaff/core";

/** Tracker identities are matched against member ids or usernames, so a blank one can never match. */
export function validateItsaplanIdentities(team: TeamConfig): ConfigWarning[] {
  const { humans, people } = identitiesOf(team, "tracker");
  return [...humans, ...people]
    .filter((ref) => ref.value.trim() === "")
    .map((ref) =>
      identityWarning(
        ref,
        WARNING_CODES.identityTrackerEmpty,
        "The tracker identity is blank.",
        `${ref.subject} cannot be matched to a member in Its a Plan; give the member's username or id.`,
      ),
    );
}

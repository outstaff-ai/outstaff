import {
  WARNING_CODES,
  identitiesOf,
  identityWarning,
  type ConfigWarning,
  type TeamConfig,
} from "@outstaff/core";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$/;
const BOT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/;

/** Humans are GitHub users; an agent is an App, whose login is `<slug>[bot]`. */
export function validateGithubIdentities(team: TeamConfig): ConfigWarning[] {
  const { humans, people } = identitiesOf(team, "vcs");
  return [
    ...humans
      .filter((ref) => !LOGIN.test(ref.value))
      .map((ref) =>
        identityWarning(
          ref,
          WARNING_CODES.identityVcsNotLogin,
          `"${ref.value}" is not a GitHub login.`,
          `${ref.subject}'s pull requests and comments will not be recognized as theirs; use the login from github.com/<login>, not a name or email.`,
        ),
      ),
    ...people
      .filter((ref) => !BOT_LOGIN.test(ref.value))
      .map((ref) =>
        identityWarning(
          ref,
          WARNING_CODES.identityVcsNotBotLogin,
          `"${ref.value}" is not a GitHub App bot login; expected <app-slug>[bot].`,
          `${ref.subject}'s own pull requests and comments will be treated as an unknown human's.`,
        ),
      ),
  ];
}

import { defineAdapter, repoAccess, type SecretSpec, type SecretsContext } from "@outstaff/core";
import { validateGithubIdentities } from "./identities.js";
import { githubCommandRules } from "./permissions.js";
import { doctorGithub } from "./doctor.js";
import { deriveGithub, githubSetupGuide } from "./setup.js";
import { githubOptions } from "./options.js";
import { createGithubVcs } from "./vcs.js";

export { createGithubVcs, type GithubDeps } from "./vcs.js";
export { githubOptions, type GithubOptions } from "./options.js";
export { githubCommandRules } from "./permissions.js";
export { signAppJwt } from "./jwt.js";

const appSecrets = (prefix: string, who: string, where: string): SecretSpec[] => [
  { key: `${prefix}ID`, description: `Numeric id of ${who}`, where },
  {
    key: `${prefix}PRIVATE_KEY`,
    description: `Private key (PEM text) of ${who}; use this or ${prefix}PRIVATE_KEY_FILE`,
    where: "The App's page > Private keys > Generate a private key",
  },
  {
    key: `${prefix}PRIVATE_KEY_FILE`,
    description: `Path to the private key PEM file, as an alternative to ${prefix}PRIVATE_KEY`,
    where: "The file downloaded when generating the key",
  },
  {
    key: `${prefix}INSTALLATION_ID`,
    description: `Installation id of ${who} on the team's account`,
    where: "The number in the installation URL, or let ost setup --derive look it up",
    derivable: true,
  },
  {
    key: `${prefix}BOT_EMAIL`,
    description: `Commit email of the bot of ${who}: <bot id>+<slug>[bot]@users.noreply.github.com`,
    where: "Let ost setup --derive look it up",
    derivable: true,
    optional: true,
  },
  {
    key: `${prefix}SLUG`,
    description: `URL slug of ${who} (its bot is <slug>[bot])`,
    where: "The App's public page URL, or let ost setup --derive look it up",
    derivable: true,
  },
];

const ownApp = (optional = false) =>
  appSecrets(
    "GH_APP_",
    "this person's own GitHub App",
    "GitHub > Settings > Developer settings > GitHub Apps > your app > About",
  ).map((s) => ({
    ...s,
    when: "the person has a write grant on any repository (optional with read grants only; unused without repository grants)",
    ...(optional ? { optional: true } : {}),
  }));

const officeApp = (forPerson = false) =>
  appSecrets(
    "GH_OFFICE_APP_",
    "the team's read-only office GitHub App",
    "GitHub > Settings > Developer settings > GitHub Apps > the office app > About",
  ).map(({ when: _when, ...s }) => ({
    ...s,
    ...(forPerson
      ? {
          when: "the person has any repository grant (agents clone read-granted repositories with it)",
        }
      : {}),
  }));

/**
 * What a person needs from GitHub follows their repository grants: nothing without grants, the office App (to read)
 * with read grants, and their own App too (required) once any grant is write. Without a person, every key.
 */
function githubSecrets(scope: "person" | "office", ctx?: SecretsContext): SecretSpec[] {
  if (scope === "office") {
    return officeApp();
  }

  switch (ctx ? repoAccess(ctx.team, ctx.person) : "write") {
    case "none":
      return [];
    case "read":
      return [...ownApp(true), ...officeApp(true)];
    case "write":
      return [...ownApp(), ...officeApp(true)];
  }
}

export const githubVcs = defineAdapter({
  port: "vcs",
  name: "github",
  capabilities: ["vcs.pullRequests", "vcs.reviewThreads", "vcs.reactions"],
  options: githubOptions,
  // Agents hold the read-only office App too: they clone read-granted repos with it.
  secrets: githubSecrets,
  unavailableFor: ({ team, person }) =>
    repoAccess(team, person) === "none"
      ? `${person.handle} has no GitHub identity; ask a human or a teammate with repository access`
      : undefined,
  create: (ctx) => createGithubVcs(ctx),
  validateIdentities: validateGithubIdentities,
  setupGuide: githubSetupGuide,
  derive: deriveGithub,
  doctor: doctorGithub,
  permissions: () => githubCommandRules(),
});

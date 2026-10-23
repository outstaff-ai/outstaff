import { defineAdapter, type SecretSpec } from "@outstaff/core";
import { validateGithubIdentities } from "./identities.js";
import { githubCommandRules } from "./permissions.js";
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
    key: `${prefix}SLUG`,
    description: `URL slug of ${who} (its bot is <slug>[bot])`,
    where: "The App's public page URL, or let ost setup --derive look it up",
    derivable: true,
  },
];

const ownApp = () =>
  appSecrets(
    "GH_APP_",
    "this person's own GitHub App",
    "GitHub > Settings > Developer settings > GitHub Apps > your app > About",
  );

const officeApp = () =>
  appSecrets(
    "GH_OFFICE_APP_",
    "the team's read-only office GitHub App",
    "GitHub > Settings > Developer settings > GitHub Apps > the office app > About",
  );

export const githubVcs = defineAdapter({
  port: "vcs",
  name: "github",
  capabilities: ["vcs.pullRequests", "vcs.reviewThreads"],
  options: githubOptions,
  // Agents hold the read-only office App too: they clone read-granted repos with it.
  secrets: (scope) => (scope === "person" ? [...ownApp(), ...officeApp()] : officeApp()),
  create: (ctx) => createGithubVcs(ctx),
  validateIdentities: validateGithubIdentities,
  permissions: () => githubCommandRules(),
});

import { repoAccess } from "../permissions/build.js";
import { CONFIG_CODES } from "./codes.js";
import type { ConfigIssue, ConfigWarning, TeamConfig } from "./types.js";
import { missingCapabilities } from "./validate-capabilities.js";
import type { TeamCheck } from "./validate.types.js";
import { WARNING_CODES } from "./warning-codes.js";

type Person = TeamConfig["people"][number];
type Access = ReturnType<typeof repoAccess>;

/** Ports whose identity lets the office recognise a person's activity there, and what that activity is. */
const IDENTITY_PORTS = [
  ["chat", WARNING_CODES.peopleMissingChatIdentity, "chat messages"],
  ["tracker", WARNING_CODES.peopleMissingTrackerIdentity, "tracker activity"],
] as const;

const unknownRole = (c: TeamCheck, name: string) => c.checkRoles && !c.ctx.roles.has(name);

const setupFix = (person: Person) =>
  `run \`ost setup ${person.handle} --derive\` and copy the value into team.yaml`;

export function personErrors(c: TeamCheck, person: Person, i: number): ConfigIssue[] {
  const errors: ConfigIssue[] = [];
  if (unknownRole(c, person.role)) {
    errors.push({
      path: ["people", i, "role"],
      code: CONFIG_CODES.peopleUnknownRole,
      message: `Role "${person.role}" is not in the catalog.`,
    });
  }

  (person.extends ?? []).forEach((name, j) => {
    if (unknownRole(c, name)) {
      errors.push({
        path: ["people", i, "extends", j],
        code: CONFIG_CODES.peopleUnknownExtends,
        message: `"${name}" is not a role in the catalog.`,
      });
    }
  });

  return [...errors, ...writesWithoutVcs(c, person, i)];
}

/** Write grants, when no configured vcs integration can open pull requests. */
function writesWithoutVcs(c: TeamCheck, person: Person, i: number): ConfigIssue[] {
  if (!c.adaptersKnown || c.provided.has("vcs.pullRequests")) {
    return [];
  }

  return Object.entries(person.repos)
    .filter(([, level]) => level === "write")
    .map(([key]) => ({
      path: ["people", i, "repos", key],
      code: CONFIG_CODES.peopleWriteWithoutVcs,
      message: `Grant "${key}: write" needs a vcs integration that provides vcs.pullRequests.`,
    }));
}

export function personWarnings(c: TeamCheck, person: Person, i: number): ConfigWarning[] {
  const access = repoAccess(c.config, person);

  return [
    ...missingVcsIdentity(c, person, i, access),
    ...missingPortIdentities(c, person, i),
    ...reviewerWithoutGithub(person, i, access),
    ...missingCapabilities(c, person, i),
  ];
}

/** Read-only people need only the office App, so their own bot login is optional. */
function missingVcsIdentity(
  c: TeamCheck,
  person: Person,
  i: number,
  access: Access,
): ConfigWarning[] {
  if (!c.config.integrations.vcs || access !== "write" || person.identities?.vcs) {
    return [];
  }

  return [
    {
      path: ["people", i, "identities", "vcs"],
      code: WARNING_CODES.peopleMissingVcsIdentity,
      message: `${person.handle} has a write grant but no identities.vcs.`,
      consequence: `the office won't recognise ${person.handle}'s pull requests and comments as the agent's own; ${setupFix(person)}.`,
    },
  ];
}

function missingPortIdentities(c: TeamCheck, person: Person, i: number): ConfigWarning[] {
  return IDENTITY_PORTS.filter(
    ([port]) => c.config.integrations[port] && !person.identities?.[port],
  ).map(([port, code, activity]) => ({
    path: ["people", i, "identities", port],
    code,
    message: `${person.handle} has no identities.${port}.`,
    consequence: `the office won't recognise ${person.handle}'s ${activity}; ${setupFix(person)}.`,
  }));
}

function reviewerWithoutGithub(person: Person, i: number, access: Access): ConfigWarning[] {
  if (person.role !== "reviewer") {
    return [];
  }

  const noGrant = access === "none";
  if (!noGrant && person.identities?.vcs) {
    return [];
  }

  return [
    {
      path: noGrant ? ["people", i, "repos"] : ["people", i, "identities", "vcs"],
      code: WARNING_CODES.peopleReviewerWithoutGithub,
      message: noGrant
        ? `${person.handle} is a reviewer but has no repo grants.`
        : `${person.handle} is a reviewer but has no identities.vcs (no GitHub App of their own).`,
      consequence: `${person.handle} cannot review pull requests as themselves; give them a read or write grant and their own GitHub App.`,
    },
  ];
}

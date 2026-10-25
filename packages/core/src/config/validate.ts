import { CAPABILITY_PORT, type Capability } from "../capabilities.js";
import { ADAPTER_PORTS, type AdapterPort } from "./adapters.js";
import { CONFIG_CODES, type ConfigCode } from "./codes.js";
import type { ConfigIssue } from "./issues.js";
import { repoAccess } from "../permissions/build.js";
import { POLICY_SWITCHES, policyOn, policyValue } from "../policies/switches.js";
import type { TeamConfig } from "./schema.js";

export type RoleNeeds = { needs: Capability[]; optionalNeeds?: Capability[] };
export type AdapterInfo = { port: AdapterPort; name: string; capabilities: Capability[] };

/** An adapter's check of the identities it owns (see `AdapterDefinition.validateIdentities`). */
export type IdentityValidator = (team: TeamConfig) => ConfigWarning[];

export type ValidationContext = {
  /** Catalog roles by name. An empty map means the catalog is unknown and role names are not checked. */
  roles: Map<string, RoleNeeds>;

  /** Installed adapters keyed by `<port>/<adapter>`. An empty map means adapter names are not checked. */
  adapters: Map<string, AdapterInfo>;

  /** Identity checks of installed adapters keyed `<port>/<adapter>`; only those of configured integrations run. Independent of `adapters`, so a host can check identities without checking adapter names. */
  identityValidators?: Map<string, IdentityValidator>;

  /** Capabilities of installed adapters keyed `<port>/<adapter>`, for the `policies` switch checks. Defaults to `adapters`; independent of it, so a host can check switches without checking adapter names. */
  adapterCapabilities?: Map<string, AdapterInfo>;
};

export type ConfigWarning = ConfigIssue & {
  /** One sentence on what will not work. */
  consequence: string;
};

export type ValidationReport = { errors: ConfigIssue[]; warnings: ConfigWarning[] };

export const WARNING_CODES = {
  capabilityMissing: "capability.missing",
  capabilityOptionalMissing: "capability.optional_missing",
  trustDefault: "trust.default",
  peopleMissingVcsIdentity: "people.missing_vcs_identity",
  peopleMissingChatIdentity: "people.missing_chat_identity",
  peopleMissingTrackerIdentity: "people.missing_tracker_identity",
  peopleReviewerWithoutGithub: "people.reviewer_without_github",
  identityChatNotMemberId: "identities.chat_not_member_id",
  identityVcsNotLogin: "identities.vcs_not_login",
  identityVcsNotBotLogin: "identities.vcs_not_bot_login",
  identityTrackerEmpty: "identities.tracker_empty",
  policyCapabilityMissing: "policies.capability_missing",
} as const;

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];

/** What an agent cannot do without a capability, completing "<role> <handle> cannot ...". */
const LACKING: Record<Capability, string> = {
  "tracker.issues": "read or update tickets",
  "tracker.assign": "be assigned tickets",
  "tracker.webhooks": "react to ticket changes instantly",
  "knowledge.docs": "write design docs",
  "vcs.pullRequests": "open or update pull requests",
  "vcs.reviewThreads": "reply to review threads",
  "vcs.workflows": "push changes to CI workflow files",
  "vcs.webhooks": "react to repository changes instantly",
  "vcs.reactions": "react to pull request comments",
  "chat.messages": "send chat messages",
  "chat.history": "read earlier chat messages",
  "chat.agentProfile": "show the agent's profile and status in chat",
  "runtime.sessions": "keep sessions between runs",
  "runtime.usage": "track LLM usage against limits",
  "avatars.generate": "get a generated avatar",
};

export const documentedCodes: Record<ConfigCode | WarningCode, string> = {
  "schema.invalid_type": "A value has the wrong type.",
  "schema.invalid_value": "A value is not one of the allowed values.",
  "schema.invalid_format": "A value does not match the required format.",
  "schema.too_small": "A value, list or string is below its minimum.",
  "schema.too_big": "A value, list or string is above its maximum.",
  "schema.unknown_key": "A key is not part of the schema.",
  "config.not_found": "No team file was found in any of the places searched.",
  "config.yaml_syntax": "The team file is not valid YAML.",
  "config.read_failed": "The team file could not be read.",
  "config.git_failed": "The team repository could not be fetched or checked out.",
  "schema.invalid": "A value fails a schema rule not covered by a more specific code.",
  "catalog.invalid_version": "catalog.version is not an exact version (for example 1.0.0).",
  "repos.duplicate_name": "Two repos share the same name.",
  "repos.multiple_primary": "More than one repo has kind primary.",
  "people.duplicate_handle": "Two people share the same handle.",
  "people.invalid_grant_key": "A repo grant key is not a repo name, kind:<kind> or *.",
  "people.unknown_repo": "A repo grant names a repo that is not listed in repos.",
  "email.missing_placeholder": "email.pattern does not contain {handle}.",
  "policies.usage_threshold_order": "defer_scheduled_at is higher than pause_automatic_at.",
  "policies.retry_backoff_order": "base_minutes is higher than cap_minutes.",
  "policies.usage_shared_unknown_person":
    "A policies.usage.shared group names someone who is not in people.",
  "policies.usage_shared_overlap": "A person appears in more than one policies.usage.shared group.",
  "policies.command_program":
    "A policies.commands entry names git, which repository grants govern.",
  "tools.invalid_version":
    "A tool version is a range, prefix or alias instead of an exact version.",
  "tools.duplicate": "A tool lists a verb twice, or two tools share a source.",
  "tools.rule_program": "A structured rule of a tool names a different program than the tool.",
  "integrations.invalid_options": "An integration's options are rejected by its adapter.",
  "people.unknown_role": "A person's role is not in the catalog.",
  "people.unknown_extends": "An extends entry names a role that is not in the catalog.",
  "people.write_without_vcs":
    "A person has a write grant but no vcs integration supports pull requests.",
  "integrations.unknown_adapter":
    "An integration names an adapter that is not installed for that port.",
  "workflow.duplicate_rule_id": "Two workflow rules share the same id.",
  "workflow.unknown_rule": "A rule is disabled by id but the preset has no rule with that id.",
  "workflow.unknown_template":
    "A rule refers to a template that is neither built in nor defined in workflow.templates.",
  "workflow.unknown_placeholder":
    "A workflow template is malformed or uses a variable that does not exist.",
  "workflow.duplicate_status_name": "Two canonical statuses map to the same tracker status name.",
  "capability.missing": "A role needs a capability that no configured integration provides.",
  "capability.optional_missing":
    "A role can use a capability that no configured integration provides.",
  "trust.default": "humans is omitted, so the default trust rule applies.",
  "people.missing_vcs_identity":
    "A person has a write grant but no identities.vcs, while a vcs integration is configured.",
  "people.missing_chat_identity":
    "A person has no identities.chat while a chat integration is configured.",
  "people.missing_tracker_identity":
    "A person has no identities.tracker while a tracker integration is configured.",
  "people.reviewer_without_github":
    "A person in the reviewer role has no repo grant, or no identities.vcs, so cannot review pull requests as themselves.",
  "identities.chat_not_member_id":
    "A chat identity is not a Slack member id (for example U0123ABCD); names never match.",
  "identities.vcs_not_login":
    "A human's vcs identity is not a GitHub login (letters, digits, hyphens or underscores, up to 39 characters).",
  "identities.vcs_not_bot_login":
    "A person's vcs identity is not a GitHub App bot login (<slug>[bot]), so the agent's own activity is not recognized.",
  "identities.tracker_empty": "A tracker identity is blank.",
  "policies.capability_missing":
    "A policies switch is on, but the configured adapter lacks the capability it needs.",
};

const adapterKey = (port: string, adapter: string) => `${port}/${adapter}`;

export function validateTeam(config: TeamConfig, ctx: ValidationContext): ValidationReport {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigWarning[] = [];

  // Capabilities provided by the adapters the team actually configured.
  const provided = new Set<Capability>();
  for (const port of ADAPTER_PORTS) {
    const ref = config.integrations[port];
    if (!ref) {
      continue;
    }

    const info = ctx.adapters.get(adapterKey(port, ref.adapter));
    if (!info) {
      if (ctx.adapters.size > 0) {
        errors.push({
          path: ["integrations", port, "adapter"],
          code: CONFIG_CODES.integrationsUnknownAdapter,
          message: `No ${port} adapter named "${ref.adapter}" is installed.`,
        });
      }

      continue;
    }

    for (const c of info.capabilities) {
      provided.add(c);
    }
  }

  // Without an adapter registry nothing is known, so capability-based checks are skipped rather than guessed.
  const adaptersKnown = ctx.adapters.size > 0;
  const canWrite = !adaptersKnown || provided.has("vcs.pullRequests");
  const checkRoles = ctx.roles.size > 0;

  config.people.forEach((person, i) => {
    if (checkRoles && !ctx.roles.has(person.role)) {
      errors.push({
        path: ["people", i, "role"],
        code: CONFIG_CODES.peopleUnknownRole,
        message: `Role "${person.role}" is not in the catalog.`,
      });
    }

    person.extends?.forEach((name, j) => {
      if (checkRoles && !ctx.roles.has(name)) {
        errors.push({
          path: ["people", i, "extends", j],
          code: CONFIG_CODES.peopleUnknownExtends,
          message: `"${name}" is not a role in the catalog.`,
        });
      }
    });

    if (!canWrite) {
      for (const [key, level] of Object.entries(person.repos)) {
        if (level !== "write") {
          continue;
        }

        errors.push({
          path: ["people", i, "repos", key],
          code: CONFIG_CODES.peopleWriteWithoutVcs,
          message: `Grant "${key}: write" needs a vcs integration that provides vcs.pullRequests.`,
        });
      }
    }

    const access = repoAccess(config, person);
    const fix = `run \`ost setup ${person.handle} --derive\` and copy the value into team.yaml`;
    // Read-only people need only the office App, so their own bot login is optional.
    const needsVcs = access === "write";
    if (config.integrations.vcs && needsVcs && !person.identities?.vcs) {
      warnings.push({
        path: ["people", i, "identities", "vcs"],
        code: WARNING_CODES.peopleMissingVcsIdentity,
        message: `${person.handle} has a write grant but no identities.vcs.`,
        consequence: `the office won't recognise ${person.handle}'s pull requests and comments as the agent's own; ${fix}.`,
      });
    }

    for (const [port, code] of [
      ["chat", WARNING_CODES.peopleMissingChatIdentity],
      ["tracker", WARNING_CODES.peopleMissingTrackerIdentity],
    ] as const) {
      if (config.integrations[port] && !person.identities?.[port]) {
        warnings.push({
          path: ["people", i, "identities", port],
          code,
          message: `${person.handle} has no identities.${port}.`,
          consequence: `the office won't recognise ${person.handle}'s ${port === "chat" ? "chat messages" : "tracker activity"}; ${fix}.`,
        });
      }
    }

    if (person.role === "reviewer") {
      const noGrant = access === "none";
      if (noGrant || !person.identities?.vcs) {
        warnings.push({
          path: noGrant ? ["people", i, "repos"] : ["people", i, "identities", "vcs"],
          code: WARNING_CODES.peopleReviewerWithoutGithub,
          message: noGrant
            ? `${person.handle} is a reviewer but has no repo grants.`
            : `${person.handle} is a reviewer but has no identities.vcs (no GitHub App of their own).`,
          consequence: `${person.handle} cannot review pull requests as themselves; give them a read or write grant and their own GitHub App.`,
        });
      }
    }

    const roleNames = [person.role, ...(person.extends ?? [])];
    const seen = new Set<string>();
    for (const [optional, code] of [
      [false, WARNING_CODES.capabilityMissing],
      [true, WARNING_CODES.capabilityOptionalMissing],
    ] as const) {
      for (const roleName of roleNames) {
        const needs = ctx.roles.get(roleName);
        if (!needs) {
          continue;
        }

        for (const cap of (optional ? needs.optionalNeeds : needs.needs) ?? []) {
          const dedupe = `${code}:${cap}`;
          if (!adaptersKnown || provided.has(cap) || seen.has(dedupe)) {
            continue;
          }

          seen.add(dedupe);
          const port = CAPABILITY_PORT[cap];
          warnings.push({
            path: ["people", i, "role"],
            code,
            message: `Role "${roleName}" ${optional ? "can use" : "needs"} ${cap}, which no configured integration provides.`,
            consequence: `${roleName} ${person.handle} cannot ${LACKING[cap]}: no ${port} integration provides ${cap}.`,
          });
        }
      }
    }
  });

  // A switch that is on but cannot do anything with the configured adapter. Without that port there is nothing to act on.
  const known = ctx.adapterCapabilities ?? ctx.adapters;
  for (const sw of POLICY_SWITCHES) {
    const cap = sw.needs;
    const ref = cap && config.integrations[CAPABILITY_PORT[cap]];
    const info = ref && known.get(adapterKey(CAPABILITY_PORT[cap], ref.adapter));
    if (
      !cap ||
      !ref ||
      !info ||
      info.capabilities.includes(cap) ||
      !policyOn(config.policies, sw.path)
    ) {
      continue;
    }

    warnings.push({
      path: ["policies", ...sw.path.split(".")],
      code: WARNING_CODES.policyCapabilityMissing,
      message: `policies.${sw.path} is ${String(policyValue(config.policies, sw.path))}, but the ${CAPABILITY_PORT[cap]} adapter "${ref.adapter}" does not provide ${cap}.`,
      consequence: `policies.${sw.path} does nothing: the ${CAPABILITY_PORT[cap]} adapter cannot ${LACKING[cap]}; set it to ${String(sw.off)} to silence this.`,
    });
  }

  if (config.humans === undefined) {
    warnings.push({
      path: ["humans"],
      code: WARNING_CODES.trustDefault,
      message: "humans is not set, so trust follows the default rule.",
      consequence:
        "trusted humans are repo writers and full chat-workspace members; set humans: for open-source repos or large workspaces",
    });
  }

  if (ctx.identityValidators) {
    for (const port of ADAPTER_PORTS) {
      const ref = config.integrations[port];
      const validator = ref && ctx.identityValidators.get(adapterKey(port, ref.adapter));
      if (validator) {
        warnings.push(...validator(config));
      }
    }
  }

  return { errors, warnings };
}

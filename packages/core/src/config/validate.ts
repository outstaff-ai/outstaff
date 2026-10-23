import { CAPABILITY_PORT, type Capability } from "../capabilities.js";
import { ADAPTER_PORTS, type AdapterPort } from "./adapters.js";
import { CONFIG_CODES, type ConfigCode } from "./codes.js";
import type { ConfigIssue } from "./issues.js";
import type { TeamConfig } from "./schema.js";

export type RoleNeeds = { needs: Capability[]; optionalNeeds?: Capability[] };
export type AdapterInfo = { port: AdapterPort; name: string; capabilities: Capability[] };

export type ValidationContext = {
  /** Catalog roles by name. An empty map means the catalog is unknown and role names are not checked. */
  roles: Map<string, RoleNeeds>;

  /** Installed adapters keyed by `<port>/<adapter>`. An empty map means adapter names are not checked. */
  adapters: Map<string, AdapterInfo>;
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
  peopleNoRepos: "people.no_repos",
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
  "vcs.webhooks": "react to repository changes instantly",
  "chat.messages": "send chat messages",
  "chat.history": "read earlier chat messages",
  "chat.homeView": "show a home view in chat",
  "runtime.sessions": "keep sessions between runs",
  "runtime.usage": "track LLM usage against limits",
  "avatars.generate": "get a generated avatar",
  "mail.inbox": "read or send email",
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
  "policies.command_program":
    "A policies.commands entry names git, which repository grants govern.",
  "integrations.invalid_options": "An integration's options are rejected by its adapter.",
  "people.unknown_role": "A person's role is not in the catalog.",
  "people.unknown_extends": "An extends entry names a role that is not in the catalog.",
  "people.write_without_vcs":
    "A person has a write grant but no vcs integration supports pull requests.",
  "integrations.unknown_adapter":
    "An integration names an adapter that is not installed for that port.",
  "capability.missing": "A role needs a capability that no configured integration provides.",
  "capability.optional_missing":
    "A role can use a capability that no configured integration provides.",
  "trust.default": "humans is omitted, so the default trust rule applies.",
  "people.no_repos": "A person has no repo grants.",
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

    if (Object.keys(person.repos).length === 0) {
      warnings.push({
        path: ["people", i, "repos"],
        code: WARNING_CODES.peopleNoRepos,
        message: `${person.handle} has no repo grants.`,
        consequence: `${person.handle} cannot read or change any repository.`,
      });
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

  if (config.humans === undefined) {
    warnings.push({
      path: ["humans"],
      code: WARNING_CODES.trustDefault,
      message: "humans is not set, so trust follows the default rule.",
      consequence:
        "trusted humans are repo writers and full chat-workspace members; set humans: for open-source repos or large workspaces",
    });
  }

  return { errors, warnings };
}

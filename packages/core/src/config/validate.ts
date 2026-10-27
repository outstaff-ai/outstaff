import { CAPABILITY_PORT } from "../capabilities.js";
import type { Capability } from "../types.js";
import { ADAPTER_PORTS } from "./adapters.js";
import { CONFIG_CODES } from "./codes.js";
import { repoAccess } from "../permissions/build.js";
import { POLICY_SWITCHES, policyOn, policyValue } from "../policies/switches.js";
import type {
  ConfigIssue,
  ConfigWarning,
  Network,
  TeamConfig,
  ValidationContext,
  ValidationReport,
} from "./types.js";
import { WARNING_CODES } from "./warning-codes.js";

/** What an agent cannot do without a capability, completing "<role> <handle> cannot ...". */
const LACKING: Record<Capability, string> = {
  "tracker.issues": "read or update tickets",
  "tracker.assign": "be assigned tickets",
  "tracker.webhooks": "react to ticket changes instantly",
  "tracker.attachments": "attach files to tickets",
  "knowledge.docs": "write design docs",
  "vcs.pullRequests": "open or update pull requests",
  "vcs.reviewThreads": "reply to review threads",
  "vcs.workflows": "push changes to CI workflow files",
  "vcs.webhooks": "react to repository changes instantly",
  "vcs.reactions": "react to pull request comments",
  "vcs.merge": "merge pull requests",
  "chat.messages": "send chat messages",
  "chat.history": "read earlier chat messages",
  "chat.agentProfile": "show the agent's profile and status in chat",
  "chat.files": "read files shared in chat",
  "runtime.sessions": "keep sessions between runs",
  "runtime.usage": "track LLM usage against limits",
  "avatars.generate": "get a generated avatar",
  "design.canvas": "work on a Design canvas",
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

  for (const role of Object.keys(config.roles ?? {})) {
    if (checkRoles && !ctx.roles.has(role)) {
      errors.push({
        path: ["roles", role],
        code: CONFIG_CODES.rolesUnknownRole,
        message: `"${role}" is not a role in the catalog.`,
      });
    }
  }

  const networks: [(string | number)[], Network | undefined][] = [
    ...Object.entries(config.roles ?? {}).map(
      ([role, r]): [(string | number)[], Network | undefined] => [["roles", role], r.network],
    ),
    ...config.people.map((p, i): [(string | number)[], Network | undefined] => [
      ["people", i],
      p.network,
    ]),
  ];

  for (const [base, network] of networks) {
    network?.http?.forEach((g, n) => {
      if (g.token && ctx.secretKeys?.has(g.token)) {
        errors.push({
          path: [...base, "network", "http", n, "token"],
          code: CONFIG_CODES.networkReservedToken,
          message: `${g.token} is a secret an integration reads; use a key of its own for the token of "${g.name}".`,
        });
      }
    });
  }

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

  if (policyOn(config.policies, "merge.on_approval")) {
    const scope = config.policies?.merge.repos;
    config.repos.forEach((repo, i) => {
      const writable = config.people.some((p) =>
        [repo.name, `kind:${repo.kind}`, "*"].some((key) => p.repos[key] === "write"),
      );

      if ((scope ? !scope.includes(repo.name) : !writable) || repo.checks?.length) {
        return;
      }

      warnings.push({
        path: ["repos", i, "checks"],
        code: WARNING_CODES.policyMergeWithoutChecks,
        message: `policies.merge.on_approval is on for repo "${repo.name}", which has no checks.`,
        consequence: `an approval merges untested code in ${repo.name}; list its checks under repos[].checks, or limit policies.merge.repos.`,
      });
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

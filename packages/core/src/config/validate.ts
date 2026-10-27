import { ADAPTER_PORTS } from "./adapters.js";
import { CONFIG_CODES } from "./codes.js";
import type { Capability } from "#/types.js";
import type {
  ConfigIssue,
  ConfigWarning,
  Network,
  TeamConfig,
  ValidationContext,
  ValidationReport,
} from "./types.js";
import { adapterKey } from "./validate-capabilities.js";
import { personErrors, personWarnings } from "./validate-people.js";
import { idleSwitches, mergesWithoutChecks } from "./validate-policies.js";
import { runtimeReport } from "./validate-runtime.js";
import type { TeamCheck } from "./validate.types.js";
import { WARNING_CODES } from "./warning-codes.js";

export function validateTeam(config: TeamConfig, ctx: ValidationContext): ValidationReport {
  const adapters = configuredAdapters(config, ctx);
  const c: TeamCheck = {
    config,
    ctx,
    provided: adapters.provided,
    adaptersKnown: ctx.adapters.size > 0,
    checkRoles: ctx.roles.size > 0,
  };

  const runtimes = runtimeReport(config, ctx);
  return {
    errors: [
      ...adapters.errors,
      ...unknownRoles(c),
      ...reservedTokens(c),
      ...config.people.flatMap((person, i) => personErrors(c, person, i)),
      ...runtimes.errors,
    ],
    warnings: [
      ...config.people.flatMap((person, i) => personWarnings(c, person, i)),
      ...idleSwitches(c),
      ...mergesWithoutChecks(config),
      ...defaultTrust(config),
      ...identityWarnings(c),
      ...runtimes.warnings,
    ],
  };
}

/**
 * Capabilities provided by the adapters the team actually configured, and the adapters not installed. Runtime
 * capabilities are each person's own (see validate-runtime).
 */
function configuredAdapters(
  config: TeamConfig,
  ctx: ValidationContext,
): { provided: Set<Capability>; errors: ConfigIssue[] } {
  const provided = new Set<Capability>();
  const errors: ConfigIssue[] = [];
  for (const port of ADAPTER_PORTS) {
    const ref = config.integrations[port];
    const info = ref && ctx.adapters.get(adapterKey(port, ref.adapter));
    if (info) {
      info.capabilities.forEach((cap) => provided.add(cap));
    } else if (ref && ctx.adapters.size > 0) {
      errors.push({
        path: ["integrations", port, "adapter"],
        code: CONFIG_CODES.integrationsUnknownAdapter,
        message: `No ${port} adapter named "${ref.adapter}" is installed.`,
      });
    }
  }

  return { provided, errors };
}

function unknownRoles(c: TeamCheck): ConfigIssue[] {
  return Object.keys(c.config.roles ?? {})
    .filter((role) => c.checkRoles && !c.ctx.roles.has(role))
    .map((role) => ({
      path: ["roles", role],
      code: CONFIG_CODES.rolesUnknownRole,
      message: `"${role}" is not a role in the catalog.`,
    }));
}

/** Network tokens that name a secret an integration reads. */
function reservedTokens({ config, ctx }: TeamCheck): ConfigIssue[] {
  const networks: [(string | number)[], Network | undefined][] = [
    ...Object.entries(config.roles ?? {}).map(
      ([role, r]): [(string | number)[], Network | undefined] => [["roles", role], r.network],
    ),
    ...config.people.map((p, i): [(string | number)[], Network | undefined] => [
      ["people", i],
      p.network,
    ]),
  ];

  return networks.flatMap(([base, network]) =>
    (network?.http ?? []).flatMap((g, n) =>
      g.token && ctx.secretKeys?.has(g.token)
        ? [
            {
              path: [...base, "network", "http", n, "token"],
              code: CONFIG_CODES.networkReservedToken,
              message: `${g.token} is a secret an integration reads; use a key of its own for the token of "${g.name}".`,
            },
          ]
        : [],
    ),
  );
}

function defaultTrust(config: TeamConfig): ConfigWarning[] {
  if (config.humans !== undefined) {
    return [];
  }

  return [
    {
      path: ["humans"],
      code: WARNING_CODES.trustDefault,
      message: "humans is not set, so trust follows the default rule.",
      consequence:
        "trusted humans are repo writers and full chat-workspace members; set humans: for open-source repos or large workspaces",
    },
  ];
}

/** The identity checks of the configured integrations' adapters. */
function identityWarnings({ config, ctx }: TeamCheck): ConfigWarning[] {
  const validators = ctx.identityValidators;
  if (!validators) {
    return [];
  }

  return ADAPTER_PORTS.flatMap((port) => {
    const ref = config.integrations[port];
    const validator = ref && validators.get(adapterKey(port, ref.adapter));
    return validator ? validator(config) : [];
  });
}

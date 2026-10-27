import { agentRegistry } from "@outstaff/agent";
import {
  formatIssue,
  validateAdapterOptions,
  validateTeam,
  type ConfigWarning,
  type AdapterPort,
  type LocatedIssue,
  type TeamConfig,
} from "@outstaff/core";
import { adapterSecretKeys } from "#/secret-keys.js";
import { catalogIssue, loadCatalogs, roleRegistry } from "#/catalogs.js";
import { defineCommand } from "#/define.js";
import { issueJson, loadTeam } from "#/load.js";
import type { Context, Loaded } from "#/types.js";

/** Importing an adapter package registers its option schema; load only the packages the team uses. */
const OPTION_SCHEMAS: Record<AdapterPort, () => Promise<unknown>> = {
  chat: () => import("@outstaff/integration.chat.slack"),
  vcs: () => import("@outstaff/integration.vcs.github"),
  tracker: () => import("@outstaff/integration.tracker.itsaplan"),
  knowledge: () => import("@outstaff/integration.knowledge.itsaplan"),
  runtime: () => import("@outstaff/integration.runtime.claude"),
  avatars: () => import("@outstaff/integration.avatars.dicebear"),
};

async function loadOptionSchemas(config: TeamConfig): Promise<void> {
  const ports = Object.keys(config.integrations) as AdapterPort[];
  await Promise.all(ports.map((port) => OPTION_SCHEMAS[port]?.()));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Warning = LocatedIssue & { consequence: string };
type Findings = { errors: LocatedIssue[]; warnings: Warning[] };

/** Every error and warning: the load errors, the catalog errors, or the team's own checks. */
async function findIssues(ctx: Context, loaded: Loaded): Promise<Findings> {
  if (!loaded.ok) {
    return { errors: loaded.issues, warnings: [] };
  }

  const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
  if (!found.ok) {
    return { errors: found.issues.map(catalogIssue), warnings: [] };
  }

  await loadOptionSchemas(loaded.config);
  const report = validateTeam(loaded.config, {
    roles: roleRegistry(found.catalogs),
    adapters: new Map(),
    identityValidators: agentRegistry().toIdentityValidators(),
    adapterCapabilities: agentRegistry().toValidationAdapters(),
    secretKeys: adapterSecretKeys(agentRegistry()),
  });

  return {
    errors: [...report.errors, ...validateAdapterOptions(loaded.config)].map(loaded.locate),
    warnings: report.warnings.map((w: ConfigWarning) => ({
      ...loaded.locate(w),
      consequence: w.consequence,
    })),
  };
}

function printText(ctx: Context, loaded: Loaded, { errors, warnings }: Findings): void {
  for (const e of errors) {
    ctx.out(`error    ${formatIssue(e)}\n`);
  }

  for (const w of warnings) {
    ctx.out(`warning  ${formatIssue(w)}\n         Consequence: ${w.consequence}\n`);
  }

  const name = loaded.ok ? `${loaded.config.team.name}: ` : "";
  ctx.out(`${name}${plural(errors.length, "error")}, ${plural(warnings.length, "warning")}\n`);
}

export const validate = defineCommand({
  name: "validate",
  summary: "Check the team config for errors and warnings.",
  description:
    "Loads the team file, checks it against the schema and cross-field rules, and lists every problem with its file, line and column. Warnings describe what will not work as written. Roles are checked against the stock catalog plus the team's ejected catalog (catalog.path); adapter names are not checked yet and are accepted as written, but the options of adapters this build ships are checked against that adapter's schema. Network grants (`network`, per person or under `roles`) are checked for origin-only URLs, unique names, a port or wireless pairing for each device, and tokens that do not reuse a secret an integration reads; whether a token secret exists is checked by `ost doctor`. The installed adapters check the identities they own (a Slack member id, a GitHub login or App bot login) and warn about malformed ones.",
  options: [],
  examples: ["ost validate", "ost validate --team ../acme-team", "ost validate --json"],
  exitCodes: [
    "0: no errors (warnings are allowed)",
    "1: the config has errors or could not be loaded",
  ],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    const findings = await findIssues(ctx, loaded);
    const ok = findings.errors.length === 0;
    if (options.json) {
      ctx.out(
        `${JSON.stringify(
          {
            ok,
            file: loaded.ok ? loaded.source.file : null,
            errors: findings.errors.map(issueJson),
            warnings: findings.warnings.map(issueJson),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      printText(ctx, loaded, findings);
    }

    return ok ? 0 : 1;
  },
});

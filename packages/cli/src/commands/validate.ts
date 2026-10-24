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
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { issueJson, loadTeam } from "../load.js";

/** Importing an adapter package registers its option schema; load only the packages the team uses. */
const OPTION_SCHEMAS: Record<AdapterPort, () => Promise<unknown>> = {
  chat: () => import("@outstaff/chat-slack"),
  vcs: () => import("@outstaff/vcs-github"),
  tracker: () => import("@outstaff/tracker-itsaplan"),
  knowledge: () => import("@outstaff/tracker-itsaplan"),
  runtime: () => import("@outstaff/runtime-agent-sdk"),
  avatars: () => import("@outstaff/avatars-dicebear"),
};

async function loadOptionSchemas(config: TeamConfig): Promise<void> {
  const ports = Object.keys(config.integrations) as AdapterPort[];
  await Promise.all(ports.map((port) => OPTION_SCHEMAS[port]?.()));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const validate = defineCommand({
  name: "validate",
  summary: "Check the team config for errors and warnings.",
  description:
    "Loads the team file, checks it against the schema and cross-field rules, and lists every problem with its file, line and column. Warnings describe what will not work as written. Roles are checked against the stock catalog plus the team's ejected catalog (catalog.path); adapter names are not checked yet and are accepted as written, but the options of adapters this build ships are checked against that adapter's schema. The installed adapters check the identities they own (a Slack member id, a GitHub login or App bot login) and warn about malformed ones.",
  options: [],
  examples: ["ost validate", "ost validate --team ../acme-team", "ost validate --json"],
  exitCodes: [
    "0: no errors (warnings are allowed)",
    "1: the config has errors or could not be loaded",
  ],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    let errors: LocatedIssue[];
    let warnings: (LocatedIssue & { consequence: string })[] = [];

    if (!loaded.ok) {
      errors = loaded.issues;
    } else {
      const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
      if (!found.ok) {
        errors = found.issues.map(catalogIssue);
      } else {
        await loadOptionSchemas(loaded.config);
        const report = validateTeam(loaded.config, {
          roles: roleRegistry(found.catalogs),
          adapters: new Map(),
          identityValidators: agentRegistry().toIdentityValidators(),
        });

        errors = [...report.errors, ...validateAdapterOptions(loaded.config)].map(loaded.locate);
        warnings = report.warnings.map((w: ConfigWarning) => ({
          ...loaded.locate(w),
          consequence: w.consequence,
        }));
      }
    }

    const ok = errors.length === 0;
    if (options.json) {
      ctx.out(
        `${JSON.stringify(
          {
            ok,
            file: loaded.ok ? loaded.source.file : null,
            errors: errors.map(issueJson),
            warnings: warnings.map(issueJson),
          },
          null,
          2,
        )}\n`,
      );

      return ok ? 0 : 1;
    }

    for (const e of errors) {
      ctx.out(`error    ${formatIssue(e)}\n`);
    }

    for (const w of warnings) {
      ctx.out(`warning  ${formatIssue(w)}\n         Consequence: ${w.consequence}\n`);
    }

    const name = loaded.ok ? `${loaded.config.team.name}: ` : "";
    ctx.out(`${name}${plural(errors.length, "error")}, ${plural(warnings.length, "warning")}\n`);
    return ok ? 0 : 1;
  },
});

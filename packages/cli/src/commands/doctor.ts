import {
  formatIssue,
  validateTeam,
  type AdapterRegistry,
  type LocatedIssue,
  type TeamConfig,
} from "@outstaff/core";
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";
import { adapterSecretKeys } from "../secret-keys.js";
import { projectRoot, secretsLocation } from "../project.js";
import type { Context, GlobalOptions, Loaded } from "../types.js";
import { printJson, printText, summarize } from "./doctor/render.js";
import { checkScope } from "./doctor/scope.js";
import type { ScopeReport } from "./doctor/types.js";
import { shippedRegistry } from "./setup/registry.js";

type LoadedTeam = Extract<Loaded, { ok: true }>;
type Catalogs = ReturnType<typeof loadCatalogs>;

function printIssues(ctx: Context, issues: readonly LocatedIssue[]): void {
  for (const i of issues) {
    ctx.err(`error    ${formatIssue(i)}\n`);
  }
}

/** The adapters the context brings, or the shipped ones when it brings none. */
const adapterRegistry = async (ctx: Context): Promise<AdapterRegistry> =>
  ctx.registry && ctx.registry.list().length > 0 ? ctx.registry : await shippedRegistry();

/** Errors in the team file or its catalogs, which doctor needs fixed before it checks anything. */
function teamIssues(
  loaded: LoadedTeam,
  found: Catalogs,
  registry: AdapterRegistry,
): LocatedIssue[] {
  if (!found.ok) {
    return found.issues.map(catalogIssue);
  }

  const context = {
    roles: roleRegistry(found.catalogs),
    adapters: new Map(),
    secretKeys: adapterSecretKeys(registry),
  };

  return validateTeam(loaded.config, context).errors.map(loaded.locate);
}

/** Why `target` names no scope of this team, or undefined when it names the office or a person. */
function unknownTarget(config: TeamConfig, target: string | undefined): string | undefined {
  if (!target || target === "office" || config.people.some((p) => p.handle === target)) {
    return undefined;
  }

  const handles = config.people.map((p) => p.handle).join(", ") || "none";
  return `Unknown person "${target}". People in this team: ${handles}. Use "office" for the office.\n`;
}

async function checkScopes(
  ctx: Context,
  options: GlobalOptions & { secretsDir?: string },
  loaded: LoadedTeam,
  found: Catalogs,
  registry: AdapterRegistry,
  target: string | undefined,
): Promise<ScopeReport[]> {
  const { config } = loaded;
  const handles = target ? [target] : ["office", ...config.people.map((p) => p.handle)];
  const root = projectRoot(ctx, loaded.source);
  const catalogs = found.ok ? found.catalogs : undefined;
  const reports: ScopeReport[] = [];
  for (const h of handles) {
    const dir = secretsLocation(ctx, options, root, h).dir;
    reports.push(await checkScope(ctx, config, h, dir, registry, catalogs));
  }

  return reports;
}

export const doctor = defineCommand<{ secretsDir?: string }>({
  name: "doctor",
  summary: "Verify the secrets and the setup of the office and of each person.",
  description:
    "Validates the team file, then for each scope checks that every required secret is present (as a file in the secrets directory or in the environment, the same way the containers read them), that secret files are mode 0600, and each adapter's live checks: the GitHub App key signs and the office App covers the granted repositories and the person's own App exactly the ones they can write, with the right permissions, the office App is read-only, the Slack bot token and ids match, the Its a Plan key works and belongs to the configured member, a Claude credential is supplied, every tool declared for the person resolves through mise, every HTTP service granted to the person answers and every adb device accepts a connection (failures inside the agent container, warnings elsewhere). Every finding names the value to fix and never prints a secret. Without a handle it checks the office and every person from one secrets directory.",
  args: "[handle|office]",
  options: [
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of secret files, used for every scope checked. Defaults to OUTSTAFF_SECRETS_DIR, then .outstaff/secrets/<handle|office> next to the team file.",
    },
  ],
  examples: [
    "ost doctor",
    "ost doctor sam --secrets-dir ./secrets-sam",
    "ost doctor office --json",
  ],
  exitCodes: [
    "0: no check failed (warnings are allowed)",
    "1: a check failed, the team file has errors, or the person is unknown",
  ],
  async run(ctx, options, args) {
    const target = args[0];
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      printIssues(ctx, loaded.issues);
      return 1;
    }

    const registry = await adapterRegistry(ctx);
    const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
    const issues = teamIssues(loaded, found, registry);
    if (issues.length > 0) {
      printIssues(ctx, issues);
      ctx.err("The team file has errors; fix them before running doctor (see `ost validate`).\n");
      return 1;
    }

    const unknown = unknownTarget(loaded.config, target);
    if (unknown) {
      ctx.err(unknown);
      return 1;
    }

    const reports = await checkScopes(ctx, options, loaded, found, registry, target);
    const summary = summarize(reports);
    (options.json ? printJson : printText)(ctx, reports, summary);
    return summary.fail === 0 ? 0 : 1;
  },
});

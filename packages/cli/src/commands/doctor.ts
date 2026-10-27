import { formatIssue, validateTeam } from "@outstaff/core";
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";
import { adapterSecretKeys } from "../secret-keys.js";
import { projectRoot, secretsLocation } from "../project.js";
import { plural } from "./doctor/check.js";
import { checkScope } from "./doctor/scope.js";
import type { ScopeReport, Status } from "./doctor/types.js";
import { shippedRegistry } from "./setup/registry.js";

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
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const { config } = loaded;
    const registry =
      ctx.registry && ctx.registry.list().length > 0 ? ctx.registry : await shippedRegistry();

    const found = loadCatalogs(ctx, config, loaded.source.dir);
    const issues = found.ok
      ? validateTeam(config, {
          roles: roleRegistry(found.catalogs),
          adapters: new Map(),
          secretKeys: adapterSecretKeys(registry),
        }).errors.map(loaded.locate)
      : found.issues.map(catalogIssue);

    if (issues.length > 0) {
      for (const i of issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      ctx.err("The team file has errors; fix them before running doctor (see `ost validate`).\n");
      return 1;
    }

    if (target && target !== "office" && !config.people.some((p) => p.handle === target)) {
      ctx.err(
        `Unknown person "${target}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}. Use "office" for the office.\n`,
      );

      return 1;
    }

    const handles = target ? [target] : ["office", ...config.people.map((p) => p.handle)];
    const root = projectRoot(ctx, loaded.source);

    const reports: ScopeReport[] = [];
    for (const h of handles) {
      reports.push(
        await checkScope(
          ctx,
          config,
          h,
          secretsLocation(ctx, options, root, h).dir,
          registry,
          found.ok ? found.catalogs : undefined,
        ),
      );
    }

    const count = (s: Status) =>
      reports.reduce((n, r) => n + r.checks.filter((c) => c.status === s).length, 0);

    const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail") };

    if (options.json) {
      ctx.out(`${JSON.stringify({ ok: summary.fail === 0, summary, scopes: reports }, null, 2)}\n`);
      return summary.fail === 0 ? 0 : 1;
    }

    for (const r of reports) {
      ctx.out(`${r.scope}\n`);
      for (const c of r.checks) {
        ctx.out(`  ${c.status.padEnd(4)}  ${c.name}: ${c.detail}\n`);
        if (c.fix && c.status !== "ok") {
          ctx.out(`        Fix: ${c.fix}\n`);
        }
      }

      ctx.out("\n");
    }

    ctx.out(
      `${summary.ok} ok, ${plural(summary.warn, "warning")}, ${plural(summary.fail, "failure")}\n`,
    );

    return summary.fail === 0 ? 0 : 1;
  },
});

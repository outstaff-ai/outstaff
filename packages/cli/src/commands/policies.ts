import { describePolicies, formatIssue, resolveWorkflow } from "@outstaff/core";
import { defineCommand } from "#/define.js";
import { loadTeam } from "#/load.js";
import { table } from "#/table.js";

export const policies = defineCommand({
  name: "policies",
  summary: "List what outstaff does on its own, with each switch's value and where it comes from.",
  description:
    "Prints every switch under `policies` in team.yaml with its effective value and its source: `default` (team.yaml says nothing), `team.yaml`, `preset` (the workflow preset has no rule for it, so the switch cannot do anything) or `workflow.rules` (an explicit rule with the same id wins over the switch). Nothing is applied. See `ost workflow explain` for what the rules do with an event.",
  options: [],
  examples: ["ost policies", "ost policies --json"],
  exitCodes: ["0: the switches were listed", "1: the team config could not be loaded"],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const { config } = loaded;
    const workflow = resolveWorkflow(config.workflow, config.humans, config.policies);
    const raw = (loaded.raw as { policies?: unknown } | undefined)?.policies;
    const report = describePolicies(config, workflow, raw);

    if (options.json) {
      ctx.out(
        `${JSON.stringify(
          report.map((r) => ({
            switch: `policies.${r.switch.path}`,
            value: r.value,
            default: r.switch.default,
            source: r.source,
            behaviour: r.switch.behaviour,
            ...(r.switch.rules ? { rules: r.switch.rules } : {}),
            ...(r.switch.needs ? { needs: r.switch.needs } : {}),
            ...(r.note ? { note: r.note } : {}),
          })),
          null,
          2,
        )}\n`,
      );

      return 0;
    }

    const rows = report.map((r) => [`policies.${r.switch.path}`, String(r.value), r.source]);
    const notes = report.filter((r) => r.note).map((r) => `  policies.${r.switch.path}: ${r.note}`);
    ctx.out(
      `${table(["SWITCH", "VALUE", "SOURCE"], rows)}\n${notes.length ? `\n${notes.join("\n")}\n` : ""}`,
    );

    return 0;
  },
});

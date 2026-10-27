import { mkdirSync, writeFileSync } from "node:fs";
import type { SetupStep } from "@outstaff/core";
import { join, relative } from "node:path";
import { loadCatalogs, roleProfile } from "../../catalogs.js";
import { shown } from "../../project.js";
import type { Context } from "../../types.js";
import { renderEnvExample, sections } from "../setup-template.js";
import { renderGuide } from "./guide.js";
import type { Configured, SetupGuide, SetupPlan } from "./types.js";

/** Writes `<envFile>.example` listing every secret of the scope; returns the file and its keys. */
function writeEnvExample(ctx: Context, plan: SetupPlan): { file: string; keys: string[] } {
  const { config, scope, target, person, out, envFile } = plan;
  const list = sections(
    config,
    plan.found.map((f) => f.def),
    scope,
    person,
  );

  const text = renderEnvExample(config, scope, target, list, shown(ctx, plan.secretsDir));
  const file = join(out, `${envFile}.example`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return { file, keys: list.flatMap((s) => s.specs.map((k) => k.key)) };
}

/** The person's role profile and capabilities, which shape the guides; empty for the office. */
function profileOf(ctx: Context, plan: SetupPlan): ReturnType<typeof roleProfile> {
  const catalogs = loadCatalogs(ctx, plan.config, plan.teamDir);
  if (!plan.person) {
    return {};
  }

  return roleProfile(catalogs.ok ? catalogs.catalogs : undefined, plan.person.role);
}

/** The steps an adapter's setup guide lists for this scope; none when it has no guide. */
function guideSteps(
  plan: SetupPlan,
  { def, options }: Configured,
  profile: ReturnType<typeof roleProfile>,
): SetupStep[] {
  const { config, scope, person } = plan;
  return (
    def.setupGuide?.({
      team: config,
      scope,
      options,
      ...(person ? { person } : {}),
      ...profile,
    }) ?? []
  );
}

/** The setup guide of each configured adapter, once per distinct guide. */
function guidesOf(ctx: Context, plan: SetupPlan): SetupGuide[] {
  const profile = profileOf(ctx, plan);
  const seen = new Set<string>();
  const guides: SetupGuide[] = [];
  for (const configured of plan.found) {
    const { def } = configured;
    const steps = guideSteps(plan, configured, profile);
    const key = JSON.stringify([def.name, steps]);
    if (steps.length > 0 && !seen.has(key)) {
      seen.add(key);
      guides.push({ adapter: `${def.name} (${def.port})`, steps });
    }
  }

  return guides;
}

function printTemplate(ctx: Context, plan: SetupPlan, file: string, guides: SetupGuide[]): void {
  ctx.out(`Wrote ${relative(ctx.cwd, file) || file}\n`);
  ctx.out(`Secret files go in ${shown(ctx, plan.secretsDir)}/, one file per key.\n\n`);
  for (const g of guides) {
    ctx.out(`${renderGuide(g.adapter, g.steps)}\n`);
  }

  for (const u of plan.unknown) {
    ctx.out(`${u}: not shipped in this build, so no secrets or guide are listed for it.\n`);
  }

  ctx.out(`When the keys are in place, run \`ost setup ${plan.target} --derive\` for the rest.\n`);
}

/** `ost setup` without --derive: writes the `.env.example` and prints a guide per adapter. */
export function writeTemplate(ctx: Context, json: boolean, plan: SetupPlan): number {
  const { file, keys } = writeEnvExample(ctx, plan);
  const guides = guidesOf(ctx, plan);
  if (!json) {
    printTemplate(ctx, plan, file, guides);
    return 0;
  }

  ctx.out(
    `${JSON.stringify(
      { file, secretsDir: plan.secretsDir, keys, guides, unsupported: plan.unknown },
      null,
      2,
    )}\n`,
  );

  return 0;
}

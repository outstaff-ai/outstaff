import type { Configured, DeriveRun } from "./types.js";

/** What one adapter makes in its provider for the team (`prepare`); a failure becomes a warning. */
async function prepareWith(run: DeriveRun, { def, options }: Configured): Promise<void> {
  if (!def.prepare) {
    return;
  }

  const { ctx, team, scope, person, report } = run;
  try {
    const made = await def.prepare(run.secrets, {
      team,
      scope,
      options,
      ...(person ? { person } : {}),
      fetch: ctx.fetch ?? fetch,
      now: ctx.now ?? (() => new Date()),
      warn: (m) => report.warnings.push(`${def.name}: ${m}`),
    });

    report.prepared.push(...made.map((line) => `${def.name}: ${line}`));
  } catch (e) {
    report.warnings.push(`${def.name}: ${(e as Error).message}`);
  }
}

/** Has each configured adapter make what the team needs in its provider, once the secrets are in place. */
export async function runPrepare(run: DeriveRun, found: Configured[]): Promise<void> {
  for (const configured of found) {
    await prepareWith(run, configured);
  }
}

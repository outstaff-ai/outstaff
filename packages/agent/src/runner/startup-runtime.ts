import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantTokenKeys, networkGrants, type RenderedWorkdir, type Runtime } from "@outstaff/core";
import { StartupError } from "./startup-error.js";
import type { RuntimeAdapter, StartupContext } from "./startup.types.js";

/** The runtime adapter the team names; one this build does not have is a startup error. */
export function runtimeAdapter({ opts, team }: StartupContext): RuntimeAdapter {
  const adapter = team.integrations.runtime.adapter;
  const def = opts.registry.get("runtime", adapter);
  if (!def) {
    throw new StartupError(`The runtime adapter "${adapter}" is not installed in this build.`);
  }

  return def;
}

/** Writes the rendered working files, laid out the way the runtime expects them. */
export function writeWorkdirFiles(def: RuntimeAdapter, rendered: RenderedWorkdir, workDir: string) {
  const files = def.workdirLayout ? def.workdirLayout(rendered.files) : rendered.files;
  for (const [path, text] of files) {
    const target = join(workDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** The secrets the runtime keeps out of the model's reach: the agent token, grant tokens and adapter secrets. */
function runtimeSecretKeys({ opts, team, me }: StartupContext): string[] {
  const network = networkGrants(team, me);

  return [
    ...new Set([
      "OUTSTAFF_AGENT_TOKEN",
      ...grantTokenKeys(network),
      ...opts.registry.list().flatMap((d) => d.secrets("person").map((s) => s.key)),
    ]),
  ];
}

export async function createRuntime(ctx: StartupContext, def: RuntimeAdapter): Promise<Runtime> {
  const { team, secrets, log } = ctx;
  const { adapter: _adapter, ...rawOptions } = team.integrations.runtime;

  return (await def.create({
    options: def.options.parse(rawOptions),
    secrets,
    secretKeys: runtimeSecretKeys(ctx),
    team,
    log,
    fetch,
    now: () => new Date(),
  })) as Runtime;
}

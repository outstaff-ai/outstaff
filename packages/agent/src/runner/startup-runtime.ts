import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantTokenKeys, networkGrants, type RenderedWorkdir, type Runtime } from "@outstaff/core";
import { selectRuntime } from "./runtime-select.js";
import type { RuntimeAdapter, StartupContext } from "./startup.types.js";

/** The runtime adapter the person runs on; one this build does not have or that cannot enforce a policy is a startup error. */
export function runtimeAdapter({ opts, team, me }: StartupContext): RuntimeAdapter {
  return selectRuntime(opts.registry, team, me).def;
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

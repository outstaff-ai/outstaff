import type { Context, GlobalOptions } from "#/types.js";
import { setup } from "#/commands/setup.js";
import { renderGuide } from "#/commands/setup/guide.js";
import { capture, parseJson } from "./capture.js";
import type { HireOptions, SetupJson } from "./types.js";

/** The options `ost setup <handle>` gets from `ost hire`; JSON, so its result can be read back. */
const setupOptions = (options: HireOptions & GlobalOptions, out: string) => ({
  ...(options.team !== undefined ? { team: options.team } : {}),
  out,
  ...(options.secretsDir !== undefined ? { secretsDir: options.secretsDir } : {}),
  json: true,
});

/** Prints what `ost setup` wrote, its guides, and what to run once the keys are in place. */
function printSetup(
  ctx: Context,
  setupJson: SetupJson,
  handle: string,
  shown: (file: string) => string,
): void {
  ctx.out(`Wrote ${shown(setupJson.file)}\n`);
  ctx.out(`Secret files go in ${shown(setupJson.secretsDir)}/, one file per key.\n\n`);
  for (const g of setupJson.guides) {
    ctx.out(`${renderGuide(g.adapter, g.steps)}\n`);
  }

  for (const u of setupJson.unsupported) {
    ctx.out(`${u}: not shipped in this build, so no secrets or guide are listed for it.\n`);
  }

  ctx.out(`When the keys are in place, run \`ost setup ${handle} --derive\` for the rest.\n\n`);
}

/** Runs `ost setup <handle>` for the new person and, outside JSON mode, prints its template and guides. */
export async function runSetup(
  ctx: Context,
  options: HireOptions & GlobalOptions,
  out: string,
  handle: string,
  shown: (file: string) => string,
): Promise<{ setupCode: number; setupJson: SetupJson | undefined; keys: string[] }> {
  // The same code as `ost setup <handle>`; its JSON is read back so the next steps can use the key list.
  const sub = capture(ctx);
  const setupCode = await setup.run(sub.ctx, setupOptions(options, out), [handle]);

  const setupJson = parseJson(sub.text()) as SetupJson | undefined;
  if (!setupJson) {
    ctx.err(sub.text());
  } else if (!options.json) {
    printSetup(ctx, setupJson, handle, shown);
  }

  return { setupCode, setupJson, keys: setupJson?.keys ?? [] };
}

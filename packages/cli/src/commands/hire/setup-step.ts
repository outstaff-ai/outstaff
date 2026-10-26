import type { Context, GlobalOptions } from "../../types.js";
import { setup } from "../setup.js";
import { renderGuide } from "../setup/guide.js";
import { capture, parseJson } from "./capture.js";
import type { HireOptions, SetupJson } from "./types.js";

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
  const setupCode = await setup.run(
    sub.ctx,
    {
      ...(options.team !== undefined ? { team: options.team } : {}),
      out,
      ...(options.secretsDir !== undefined ? { secretsDir: options.secretsDir } : {}),
      json: true,
    },
    [handle],
  );

  const setupJson = parseJson(sub.text()) as SetupJson | undefined;
  const keys = setupJson?.keys ?? [];
  if (!setupJson) {
    ctx.err(sub.text());
  } else if (!options.json) {
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

  return { setupCode, setupJson, keys };
}

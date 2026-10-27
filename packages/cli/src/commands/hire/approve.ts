import type { Context, GlobalOptions } from "../../types.js";
import type { ChosenPerson, HireOptions } from "./types.js";

/** Whether to write the person: --yes, or a confirmation after the summary. Prints why not. */
export async function approved(
  ctx: Context,
  options: HireOptions & GlobalOptions,
  chosen: ChosenPerson,
): Promise<boolean> {
  if (options.yes) {
    return true;
  }

  const canAsk = !options.json && ctx.confirm !== undefined;
  if (!options.json) {
    ctx.out(`${chosen.summary.join("\n")}\n`);
  }

  if (canAsk && (await ctx.confirm!(`Add ${chosen.name} to the team?`))) {
    return true;
  }

  if (options.json) {
    ctx.out(`${JSON.stringify({ person: chosen.person, written: false }, null, 2)}\n`);
  }

  ctx.err(
    canAsk
      ? "Nothing was written.\n"
      : "error    Not confirmed, so nothing was written. Run again with --yes to write.\n",
  );

  return false;
}

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderPerson, type RenderPersonOptions, type RenderedWorkdir } from "./render.js";

export type RenderToDirOptions = RenderPersonOptions & {
  out: string;

  /** Write into a non-empty directory. Existing files with the same path are overwritten. */
  force?: boolean;
};

/** Renders a person and writes the files below `out`. */
export function renderToDir(options: RenderToDirOptions): RenderedWorkdir {
  const { out, force, ...rest } = options;
  if (!force && existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`Output directory ${out} is not empty; pass force to write into it.`);
  }

  const result = renderPerson(rest);
  for (const [path, text] of result.files) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  return result;
}

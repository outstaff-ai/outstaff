import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Context, GlobalOptions } from "../../types.js";
import { validate } from "../validate.js";
import { renderAvatar } from "./avatar.js";
import { capture, parseJson } from "./capture.js";
import { nextStepsOf, renderNextSteps } from "./next-steps.js";
import { runSetup } from "./setup-step.js";
import type { Hired, HireOptions, PlacedAvatar } from "./types.js";

/** Renders the avatar into the person's folder, unless it is a URL or the team renders none. */
async function placeAvatar(ctx: Context, hired: Hired): Promise<PlacedAvatar> {
  const { seed, isUrl, handle } = hired.chosen;
  if (isUrl) {
    return {
      avatarFile: null,
      notes: ["The avatar is a URL; it is stored in the team file and nothing was rendered."],
    };
  }

  try {
    const image = await renderAvatar(ctx, hired.config, seed, hired.secretsDir);
    if ("skipped" in image) {
      return { avatarFile: null, notes: [image.skipped] };
    }

    const avatarFile = join(hired.out, ".outstaff", "people", handle, `avatar.${image.ext}`);
    mkdirSync(join(avatarFile, ".."), { recursive: true });
    writeFileSync(avatarFile, image.data);
    return { avatarFile, notes: [] };
  } catch (e) {
    return {
      avatarFile: null,
      notes: [`The avatar could not be rendered: ${(e as Error).message}`],
    };
  }
}

function printAdded(
  ctx: Context,
  hired: Hired,
  avatarFile: string | null,
  shown: (file: string) => string,
): void {
  const { name, handle } = hired.chosen;
  ctx.out(`Added ${name} (${handle}) to ${shown(hired.file)}\n`);
  if (avatarFile) {
    ctx.out(`Wrote ${shown(avatarFile)}\n`);
  }

  ctx.out("\n");
}

function printNextSteps(
  ctx: Context,
  hired: Hired,
  nextSteps: ReturnType<typeof nextStepsOf>,
  notes: string[],
): void {
  ctx.out(renderNextSteps(nextSteps, hired.chosen.name, hired.chosen.handle));
  for (const n of notes) {
    ctx.out(`note     ${n}\n`);
  }

  ctx.out("\n");
}

const validateOptions = (options: GlobalOptions): GlobalOptions => ({
  ...(options.team !== undefined ? { team: options.team } : {}),
  json: options.json === true,
});

/**
 * After the person is in the team file: renders the avatar, does what `ost setup <handle>` does, prints the next
 * steps and runs `ost validate`. Resolves to the exit code.
 */
export async function finishHire(
  ctx: Context,
  options: HireOptions & GlobalOptions,
  hired: Hired,
): Promise<number> {
  const json = options.json === true;
  const { handle } = hired.chosen;
  const { avatarFile, notes } = await placeAvatar(ctx, hired);
  const shown = (file: string) => relative(ctx.cwd, file) || file;
  if (!json) {
    printAdded(ctx, hired, avatarFile, shown);
  }

  const { setupCode, setupJson, keys } = await runSetup(ctx, options, hired.out, handle, shown);
  const nextSteps = nextStepsOf(handle, keys);
  if (!json) {
    printNextSteps(ctx, hired, nextSteps, notes);
  }

  const checks = json ? capture(ctx) : { ctx, text: () => "" };
  const validateCode = await validate.run(checks.ctx, validateOptions(options), []);
  if (json) {
    ctx.out(
      `${JSON.stringify(
        {
          person: hired.chosen.person,
          written: true,
          file: hired.file,
          avatar: avatarFile,
          notes,
          setup: { ok: setupCode === 0, ...setupJson },
          nextSteps,
          validate: parseJson(checks.text()) ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }

  return setupCode === 0 && validateCode === 0 ? 0 : 1;
}

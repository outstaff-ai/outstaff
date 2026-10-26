import { PortError, type ReviewComment } from "@outstaff/core";
import { z } from "zod";
import { ticketLinker } from "./support.js";
import { readInputFile } from "./files.js";
import { mentionGuard } from "./mentions.js";
import type { AgentEnv, VerbContext } from "./types.js";

export const repo = z
  .string()
  .min(1)
  .max(300)
  .optional()
  .describe(
    "Repository: its name in team.yaml or host/owner/name. Default: the repository the current worktree's origin points at.",
  );

export const number = z.number().int().min(1).describe("Pull request number.");

export const body = z
  .string()
  .max(65_000)
  .optional()
  .describe("Text, Markdown. Or pass body-file.");

export const bodyFile = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe(
    "File with the text, Markdown (in the worktree or your scratch directory; the read policy applies). Use it for long text.",
  );

/** Mentions guarded, then ticket keys linked the way the code host wants (wrong links only; GitHub autolinks bare keys). */
export function guarded(env: AgentEnv, text: string): string {
  return ticketLinker(env).format(mentionGuard(env.team).apply(text), "host");
}

/** The text from `body` or `body-file`, with @-mentions guarded and ticket links fixed; `undefined` when neither is given and it is optional. */
export function textOf(
  env: AgentEnv,
  ctx: VerbContext,
  input: { body?: string | undefined; bodyFile?: string | undefined },
  required: boolean,
): string | undefined {
  if (input.body !== undefined && input.bodyFile !== undefined) {
    throw new PortError("invalid", "Pass either body or body-file, not both.");
  }

  if (input.bodyFile !== undefined) {
    return guarded(env, readInputFile(env, ctx, input.bodyFile, "body file"));
  }

  if (input.body === undefined && required) {
    throw new PortError("invalid", "Pass body or body-file.");
  }

  return input.body === undefined ? undefined : guarded(env, input.body);
}

const inlineComments = z
  .array(
    z.strictObject({
      path: z.string().min(1).max(1000),
      line: z.number().int().min(1),
      body: z.string().min(1).max(65_000),
    }),
  )
  .max(100);

export function commentsOf(
  env: AgentEnv,
  ctx: VerbContext,
  file: string | undefined,
): ReviewComment[] | undefined {
  if (file === undefined) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readInputFile(env, ctx, file, "comment file"));
  } catch (e) {
    if (e instanceof PortError) {
      throw e;
    }

    throw new PortError("invalid", `Comment file ${file} is not JSON.`, { cause: e });
  }

  const parsed = inlineComments.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new PortError(
      "invalid",
      `Comment file ${file} must be a JSON array of { path, line, body }: ${problems.join("; ")}`,
    );
  }

  return parsed.data.map((c) => ({ ...c, body: guarded(env, c.body) }));
}

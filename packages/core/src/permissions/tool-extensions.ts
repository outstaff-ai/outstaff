import type { z } from "zod";
import { CONFIG_CODES } from "#/config/codes.js";
import { customIssue } from "#/config/issues.js";
import type { ToolExtension } from "./tool-extensions.types.js";

const EXTENSION = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@(\S+)$/;

/** A release tag such as v1.2.0 or 1.2.0; branches and aliases such as main or latest do not match. */
const TAG = /^v?\d+(\.\d+)+([-+.][0-9A-Za-z.+-]+)?$/;

/** A full commit id; a short one could name another commit later. */
const COMMIT = /^[0-9a-f]{40}$/;

/** `owner/name@ref` as its parts; undefined when the text is not in that form. */
export function parseToolExtension(text: string): ToolExtension | undefined {
  const m = EXTENSION.exec(text);
  return m ? { owner: m[1]!, name: m[2]!, ref: m[3]! } : undefined;
}

/** Whether a ref is an exact release tag or a full commit id, which is what pins an extension. */
export const isPinnedRef = (ref: string): boolean => TAG.test(ref) || COMMIT.test(ref);

/** Extensions of tool `name` that are not `owner/name@ref`, not pinned, or listed twice. */
export function checkExtensions(
  name: string,
  extensions: string[] | undefined,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  (extensions ?? []).forEach((text, i) => {
    const path = [name, "extensions", i];
    const ext = parseToolExtension(text);
    if (!ext) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.toolsInvalidExtension,
          `Extension "${text}" of tool "${name}" is not <owner>/<repository>@<release tag or commit>.`,
          path,
        ),
      );

      return;
    }

    if (!isPinnedRef(ext.ref)) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.toolsUnpinnedExtension,
          `Extension "${text}" of tool "${name}" is not pinned: give an exact release tag such as v1.2.0 or a full 40-character commit id, not a branch or alias.`,
          path,
        ),
      );
    }

    const repo = `${ext.owner}/${ext.name}`.toLowerCase();
    if (seen.has(repo)) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.toolsDuplicate,
          `Extension ${ext.owner}/${ext.name} is listed twice.`,
          path,
        ),
      );
    }

    seen.add(repo);
  });
}

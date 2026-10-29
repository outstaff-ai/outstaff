import type { z } from "zod";
import { CONFIG_CODES } from "#/config/codes.js";
import { customIssue } from "#/config/issues.js";
import type { ToolDeclaration } from "./types.js";

type Entries = ToolDeclaration["allow"] | ToolDeclaration["deny"];

/** A verb listed twice, or a rule naming another program, in the `allow` or `deny` list of tool `name`. */
export function checkEntries(
  name: string,
  key: "allow" | "deny",
  entries: Entries,
  ctx: z.RefinementCtx,
): void {
  if (!Array.isArray(entries)) {
    return;
  }

  const seen = new Set<string>();
  entries.forEach((entry, i) => {
    if (typeof entry !== "string") {
      checkProgram(name, key, entry.program, i, ctx);
      return;
    }

    if (seen.has(entry)) {
      ctx.addIssue(
        customIssue(CONFIG_CODES.toolsDuplicate, `Verb "${entry}" is listed twice.`, [
          name,
          key,
          i,
        ]),
      );
    }

    seen.add(entry);
  });
}

function checkProgram(
  name: string,
  key: "allow" | "deny",
  program: string | undefined,
  i: number,
  ctx: z.RefinementCtx,
): void {
  if (program !== undefined && program !== name) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsRuleProgram,
        `A rule of tool "${name}" names program "${program}"; omit program or use "${name}".`,
        [name, key, i, "program"],
      ),
    );
  }
}

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { toolsetSchema } from "./schema.js";
import type { ArgPredicate, CommandRule, RulePack, TeamCommands, Toolset } from "./types.js";

type ToolsetRule = NonNullable<Toolset["rules"]>[number];

export function parseToolset(text: string, source = "toolset"): Toolset {
  const parsed = toolsetSchema.safeParse(parse(text));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    throw new Error(`Invalid toolset ${source}: ${problems}`);
  }

  return parsed.data;
}

export function loadToolset(file: string): Toolset {
  return parseToolset(readFileSync(file, "utf8"), file);
}

function idFor(prefix: string, effect: string, program: string, sub?: string[]): string {
  return [prefix, effect, program, ...(sub ?? [])].join(".");
}

/** A command rule's optional fields, as a declaration may give them. */
type OptionalFields = {
  subcommand?: string[] | undefined;
  args?: unknown[] | undefined;
  pathArgs?: CommandRule["pathArgs"];
  requiresRepo?: CommandRule["requiresRepo"];
};

/** A command rule with only the optional fields the declaration sets. */
function commandRule(
  { id, program, effect, reason }: Pick<CommandRule, "id" | "program" | "effect" | "reason">,
  { subcommand, args, pathArgs, requiresRepo }: OptionalFields,
): CommandRule {
  return {
    id,
    program,
    ...(subcommand ? { subcommand } : {}),
    ...(args ? { args: args as ArgPredicate[] } : {}),
    effect,
    reason,
    ...(pathArgs ? { pathArgs } : {}),
    ...(requiresRepo ? { requiresRepo } : {}),
  };
}

export function toolsetToPack(toolset: Toolset): RulePack {
  return {
    id: `toolset.${toolset.name}`,
    source: "toolset",
    ...(toolset.profiles ? { profiles: toolset.profiles } : {}),
    rules: (toolset.rules ?? []).flatMap((r) => toolsetRules(toolset.name, r)),
  };
}

/** One rule per program and verb of a toolset rule. */
function toolsetRules(toolset: string, r: ToolsetRule): CommandRule[] {
  const programs = typeof r.program === "string" ? [r.program] : r.program;
  const subs: (string[] | undefined)[] = r.verbs ? r.verbs.map((v) => [v]) : [r.subcommand];

  return programs.flatMap((program) =>
    subs.map((sub) =>
      commandRule(
        { id: idFor(toolset, r.effect, program, sub), program, effect: r.effect, reason: r.reason },
        { subcommand: sub, args: r.args, pathArgs: r.path_args, requiresRepo: r.requires_repo },
      ),
    ),
  );
}

/** The `policies.commands` section of team.yaml as a rule pack, or undefined when it is empty. */
export function teamCommandsToPack(commands: TeamCommands | undefined): RulePack | undefined {
  const rules = (["allow", "deny"] as const).flatMap((effect) =>
    (commands?.[effect] ?? []).map((c) =>
      commandRule(
        {
          id: idFor("team", effect, c.program, c.subcommand),
          program: c.program,
          effect,
          reason: c.reason,
        },
        { subcommand: c.subcommand, args: c.args, requiresRepo: c.requires_repo },
      ),
    ),
  );

  return rules.length === 0 ? undefined : { id: "team", source: "team", rules };
}

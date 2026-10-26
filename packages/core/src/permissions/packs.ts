import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { toolsetSchema } from "./schema.js";
import type { ArgPredicate, CommandRule, RulePack, TeamCommands, Toolset } from "./types.js";

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

export function toolsetToPack(toolset: Toolset): RulePack {
  const rules: CommandRule[] = [];
  for (const r of toolset.rules ?? []) {
    const programs = typeof r.program === "string" ? [r.program] : r.program;
    const subs: (string[] | undefined)[] = r.verbs ? r.verbs.map((v) => [v]) : [r.subcommand];
    for (const program of programs) {
      for (const sub of subs) {
        rules.push({
          id: idFor(toolset.name, r.effect, program, sub),
          program,
          ...(sub ? { subcommand: sub } : {}),
          ...(r.args ? { args: r.args as ArgPredicate[] } : {}),
          effect: r.effect,
          reason: r.reason,
          ...(r.path_args ? { pathArgs: r.path_args } : {}),
          ...(r.requires_repo ? { requiresRepo: r.requires_repo } : {}),
        });
      }
    }
  }

  return {
    id: `toolset.${toolset.name}`,
    source: "toolset",
    ...(toolset.profiles ? { profiles: toolset.profiles } : {}),
    rules,
  };
}

/** The `policies.commands` section of team.yaml as a rule pack, or undefined when it is empty. */
export function teamCommandsToPack(commands: TeamCommands | undefined): RulePack | undefined {
  const rules: CommandRule[] = [];
  for (const effect of ["allow", "deny"] as const) {
    for (const c of commands?.[effect] ?? []) {
      rules.push({
        id: idFor("team", effect, c.program, c.subcommand),
        program: c.program,
        ...(c.subcommand ? { subcommand: c.subcommand } : {}),
        ...(c.args ? { args: c.args as ArgPredicate[] } : {}),
        effect,
        reason: c.reason,
        ...(c.requires_repo ? { requiresRepo: c.requires_repo } : {}),
      });
    }
  }

  return rules.length === 0 ? undefined : { id: "team", source: "team", rules };
}

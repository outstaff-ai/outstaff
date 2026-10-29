import type {
  ArgPredicate,
  CommandRule,
  EffectiveTool,
  EffectiveToolsInput,
  RulePack,
  Toolset,
} from "./types.js";

/** Person beats team beats toolset; the winning declaration replaces the others whole, so its `allow` is the only one. */
export function effectiveTools(input: EffectiveToolsInput): EffectiveTool[] {
  const out = new Map<string, EffectiveTool>();
  for (const tool of (input.toolsets ?? []).flatMap(toolsetTools)) {
    out.set(tool.name, tool);
  }

  for (const [origin, tools] of [
    ["team", input.team],
    ["person", input.person],
  ] as const) {
    for (const [name, t] of Object.entries(tools ?? {})) {
      out.set(name, { ...t, name, origin });
    }
  }

  return [...out.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

function toolsetTools(ts: Toolset): EffectiveTool[] {
  return Object.entries(ts.tools ?? {}).map(([name, t]) => ({
    ...t,
    name,
    origin: "toolset",
    toolset: ts.name,
    ...(ts.profiles ? { profiles: ts.profiles } : {}),
  }));
}

type Entry = Exclude<NonNullable<EffectiveTool["allow"]>, "all">[number];

/** The rules of a tool: its allow rules ("all" when it gives none), then its deny rules. */
function toolRules(tool: EffectiveTool): CommandRule[] {
  const { allow = "all", deny = [], name, valued_options } = tool;
  const valued = valued_options ? { valuedOptions: valued_options } : {};
  const allows =
    allow === "all"
      ? [{ ...allRule(name), ...valued }]
      : allow.map((entry, i) => ({ ...entryRule(name, "allow", entry, i), ...valued }));

  return [
    ...allows,
    ...deny.map((entry, i) => ({ ...entryRule(name, "deny", entry, i), ...valued })),
  ];
}

const allRule = (name: string): CommandRule => ({
  id: `tools.${name}.all`,
  program: name,
  effect: "allow",
  reason: `${name} is declared in tools.`,
});

/** The rule of one `allow` or `deny` entry: a first subcommand, or a structured rule. */
function entryRule(
  name: string,
  effect: CommandRule["effect"],
  entry: Entry,
  i: number,
): CommandRule {
  const prefix = effect === "allow" ? `tools.${name}` : `tools.${name}.deny`;
  if (typeof entry === "string") {
    return {
      id: `${prefix}.${entry}`,
      program: name,
      subcommand: [entry],
      effect,
      reason: `${name} ${entry} is ${effect === "allow" ? "allowed" : "denied"} by the ${name} tools declaration.`,
    };
  }

  return {
    id: `${prefix}.${i}`,
    program: name,
    ...(entry.subcommand ? { subcommand: entry.subcommand } : {}),
    ...(entry.args ? { args: entry.args as ArgPredicate[] } : {}),
    effect,
    reason: entry.reason,
    ...(entry.requires_repo ? { requiresRepo: entry.requires_repo } : {}),
  };
}

/**
 * The rules of the effective tools. A tool without `allow` (or with `all`) runs with any arguments and lifts the
 * built-in default denies for its program; a list or rules narrow it to what they match. Its `deny` rules always win.
 */
export function toolsToPacks(tools: EffectiveTool[]): RulePack[] {
  const packs = new Map<string, RulePack>();
  for (const t of tools) {
    const id = t.origin === "toolset" ? `toolset.${t.toolset}.tools` : `${t.origin}.tools`;
    let pack = packs.get(id);
    if (!pack) {
      pack = {
        id,
        source: t.origin === "toolset" ? "toolset" : "team",
        ...(t.profiles ? { profiles: t.profiles } : {}),
        rules: [],
      };

      packs.set(id, pack);
    }

    pack.rules.push(...toolRules(t));
  }

  return [...packs.values()];
}

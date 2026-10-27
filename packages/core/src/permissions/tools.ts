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

function toolRules(tool: EffectiveTool): CommandRule[] {
  const id = (...parts: string[]) => ["tools", tool.name, ...parts].join(".");
  const { allow = "all", name } = tool;
  if (allow === "all") {
    return [
      {
        id: id("all"),
        program: name,
        effect: "allow",
        reason: `${name} is declared in tools.`,
      },
    ];
  }

  return allow.map((entry, i): CommandRule => {
    if (typeof entry === "string") {
      return {
        id: id(entry),
        program: name,
        subcommand: [entry],
        effect: "allow",
        reason: `${name} ${entry} is declared in tools.`,
      };
    }

    return {
      id: id(String(i)),
      program: name,
      ...(entry.subcommand ? { subcommand: entry.subcommand } : {}),
      ...(entry.args ? { args: entry.args as ArgPredicate[] } : {}),
      effect: "allow",
      reason: entry.reason,
      ...(entry.requires_repo ? { requiresRepo: entry.requires_repo } : {}),
    };
  });
}

/**
 * The allow rules of the effective tools. A tool without `allow` (or with `all`) runs with any arguments and lifts the
 * built-in default denies for its program; a list or rules narrow it to what they match.
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

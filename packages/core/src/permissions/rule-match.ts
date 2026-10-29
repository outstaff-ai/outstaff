import { checkPath } from "./check-path.js";
import { allow, deny } from "./decision.js";
import { repoFor } from "./git.js";
import { leadingValues, operands } from "./operands.js";
import type { ArgPredicate, CommandRule, Decision, Policy } from "./types.js";

function flagValues(args: string[], names: string[]): string[] | null {
  const found = args.flatMap((a, i) => names.flatMap((name) => flagValue(a, args[i + 1], name)));

  return found.length === 0 ? null : found;
}

/** The value `a` gives the flag `name`: the next word, the part after `--name=`, or the rest of a joined `-n5`. */
function flagValue(a: string, next: string | undefined, name: string): string[] {
  if (a === name) {
    return [next ?? ""];
  }

  if (name.startsWith("--")) {
    return a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : [];
  }

  const joined = !a.startsWith("--") && a.startsWith(name) && a.length > name.length;

  return joined ? [a.slice(name.length).replace(/^=/, "")] : [];
}

function predicateHolds(p: ArgPredicate, args: string[], positionals: string[]): boolean {
  switch (p.kind) {
    case "flag":
      return (flagValues(args, p.names) !== null) === p.present;
    case "flag-value": {
      const values = flagValues(args, p.names);
      if (values === null) {
        return false;
      }

      const set = new Set(p.values.map((v) => v.toLowerCase()));
      const hit = values.some((v) => set.has(v.toLowerCase()));
      return p.match === "in" ? hit : values.some((v) => !set.has(v.toLowerCase()));
    }

    case "positional": {
      const v = positionals[p.index];
      return v !== undefined && new RegExp(p.pattern, "i").test(v);
    }
  }
}

/**
 * Whether the rule applies to the command, and the positionals after its subcommand when it does. A deny rule of a
 * program whose valued options are not declared also tries each leading word that may be an option's value as not
 * being the subcommand, so `-c prod delete` cannot hide a denied `delete`.
 */
function matchRule(
  r: CommandRule,
  program: string,
  args: string[],
): { positionals: string[] } | null {
  if (r.program !== program) {
    return null;
  }

  const all = operands(args, r.valuedOptions);
  const skips = r.effect === "deny" && !r.valuedOptions ? leadingValues(args) : 0;
  for (let skip = 0; skip <= skips; skip++) {
    const m = matchAt(r, args, all.slice(skip));
    if (m) {
      return m;
    }
  }

  return null;
}

function matchAt(
  r: CommandRule,
  args: string[],
  words: string[],
): { positionals: string[] } | null {
  const sub = r.subcommand ?? [];
  if (sub.some((w, i) => words[i] !== w)) {
    return null;
  }

  const positionals = words.slice(sub.length);
  if (!(r.args ?? []).every((p) => predicateHolds(p, args, positionals))) {
    return null;
  }

  return { positionals };
}

/**
 * Deny rules win. A program no allow rule names runs (built-in fallback denies still apply to it); a program that allow
 * rules name runs only what one of them allows.
 */
export function evaluateCommandRules(
  policy: Policy,
  program: string,
  args: string[],
  cwd: string,
): Decision {
  const named = policy.commands.filter((r) => r.program === program);
  const matches = named.map((r) => ({ r, m: matchRule(r, program, args) })).filter((x) => x.m);

  const denied = matches.find((x) => x.r.effect === "deny" && !x.r.fallback);
  if (denied) {
    return deny(denied.r.reason, denied.r.id);
  }

  const narrowed = named.some((r) => r.effect === "allow");
  if (!narrowed) {
    const fallback = matches.find((x) => x.r.effect === "deny");
    return fallback
      ? deny(fallback.r.reason, fallback.r.id)
      : allow(`${program} runs inside the sandbox.`, "commands.default");
  }

  const hit = matches.find((x) => x.r.effect === "allow");
  if (!hit) {
    return deny(
      `${program} is limited to the commands its tools declaration or team rules allow, and this is not one of them.`,
      "commands.narrowed",
    );
  }

  const { r, m } = hit;

  return (
    unmetRepoRequirement(policy, r, program, args, cwd) ??
    deniedPathArgument(policy, r, m!.positionals, cwd) ??
    allow(r.reason, r.id)
  );
}

/** Why the repository the command runs in does not meet the rule's `requiresRepo`, if it does not. */
function unmetRepoRequirement(
  policy: Policy,
  r: CommandRule,
  program: string,
  args: string[],
  cwd: string,
): Decision | undefined {
  if (!r.requiresRepo) {
    return undefined;
  }

  if (flagValues(args, ["-R", "--repo"]) !== null) {
    return deny(
      "A -R/--repo target cannot be mapped to a granted repository.",
      "commands.repo-flag",
    );
  }

  const repo = repoFor(policy, cwd);
  if (!repo) {
    return deny(`${program} ran outside the granted repositories.`, "git.no-repo");
  }

  if (r.requiresRepo === "write" && repo.mode !== "write") {
    return deny("This repository is read-only for this person.", "git.read-only-repo");
  }
}

/** The first positional the rule's `pathArgs` refuses, as its decision. */
function deniedPathArgument(
  policy: Policy,
  r: CommandRule,
  positionals: string[],
  cwd: string,
): Decision | undefined {
  if (!r.pathArgs) {
    return undefined;
  }

  for (const raw of positionals) {
    const d = checkPath(policy, r.pathArgs, raw, cwd);
    if (d.effect !== "allow") {
      return d;
    }
  }
}

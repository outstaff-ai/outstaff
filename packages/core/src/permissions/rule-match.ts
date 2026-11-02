import { checkPath } from "./check-path.js";
import { allow, deny } from "./decision.js";
import { repoFor } from "./git.js";
import { leadingValues, operands } from "./operands.js";
import { narrowedDenial } from "./narrowed-denial.js";
import { knownOptions } from "./program-options.js";
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
 * The words a command may hold after its leading options, one list per reading: the first takes every leading option
 * that is not known to take a value as a flag, each next one takes one more of them as taking the following word. A
 * program whose rules declare `valuedOptions` is read exactly, as is one whose leading options are all known.
 */
function readings(rules: CommandRule[], program: string, args: string[]): string[][] {
  const known = knownOptions(program);
  const declared = rules.flatMap((r) => r.valuedOptions ?? []);
  const valued = [...known.valued, ...declared];
  const all = operands(args, valued);
  const guesses = declared.length > 0 ? 0 : leadingValues(args, valued, known.flags);

  return Array.from({ length: guesses + 1 }, (_, skip) => all.slice(skip));
}

/** Whether the rule applies to one reading of the command, and the positionals after its subcommand when it does. */
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

type Hit = { r: CommandRule; positionals: string[] };

/** The first of the rules that matches the reading. */
function hitAt(rules: CommandRule[], args: string[], words: string[]): Hit | undefined {
  for (const r of rules) {
    const m = matchAt(r, args, words);
    if (m) {
      return { r, ...m };
    }
  }
}

/**
 * Deny rules win, on any reading of the command, so `-c prod delete` cannot hide a denied `delete`. A program no allow
 * rule names runs (built-in fallback denies still apply to it); a program that allow rules name runs only what they
 * allow, on every reading that has a subcommand, so `-n get delete` cannot pass as a `get`.
 */
export function evaluateCommandRules(
  policy: Policy,
  program: string,
  args: string[],
  cwd: string,
): Decision {
  const named = policy.commands.filter((r) => r.program === program);
  const views = readings(named, program, args);
  const denyRules = named.filter((r) => r.effect === "deny");
  const denied = views.flatMap((w) => hitAt(denyRules, args, w) ?? []);

  const hard = denied.find((x) => !x.r.fallback);
  if (hard) {
    return deny(hard.r.reason, hard.r.id);
  }

  const allowRules = named.filter((r) => r.effect === "allow");
  if (allowRules.length > 0) {
    return evaluateNarrowed(policy, { program, args, cwd }, allowRules, views);
  }

  const fallback = denied[0];

  return fallback
    ? deny(fallback.r.reason, fallback.r.id)
    : allow(`${program} runs inside the sandbox.`, "commands.default");
}

type Command = { program: string; args: string[]; cwd: string };

/** A program that allow rules name: every reading must hit one, and each hit's repository and path checks must pass. */
function evaluateNarrowed(
  policy: Policy,
  { program, args, cwd }: Command,
  allowRules: CommandRule[],
  views: string[][],
): Decision {
  // A reading in which an option took the last word runs no subcommand; the others decide.
  const decisive = views.filter((words, k) => k === 0 || words.length > 0);
  const hits: Hit[] = [];
  for (const words of decisive) {
    const hit = hitAt(allowRules, args, words);
    if (!hit) {
      return narrowedDenial(program, allowRules, words, views.length > 1);
    }

    hits.push(hit);
  }

  for (const { r, positionals } of hits) {
    const refused =
      unmetRepoRequirement(policy, r, program, args, cwd) ??
      deniedPathArgument(policy, r, positionals, cwd);

    if (refused) {
      return refused;
    }
  }

  return allow(hits[0]!.r.reason, hits[0]!.r.id);
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

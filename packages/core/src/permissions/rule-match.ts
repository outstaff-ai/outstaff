import { checkPath } from "./check-path.js";
import { allow, deny } from "./decision.js";
import { repoFor } from "./git.js";
import type { ArgPredicate, CommandRule, Decision, Policy } from "./types.js";

function flagValues(args: string[], names: string[]): string[] | null {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) {
        found.push(args[i + 1] ?? "");
      } else if (name.startsWith("--") && a.startsWith(`${name}=`)) {
        found.push(a.slice(name.length + 1));
      } else if (
        !name.startsWith("--") &&
        a.startsWith(name) &&
        !a.startsWith("--") &&
        a.length > name.length
      ) {
        found.push(a.slice(name.length).replace(/^=/, ""));
      }
    }
  }

  return found.length === 0 ? null : found;
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

function matchRule(
  r: CommandRule,
  program: string,
  args: string[],
): { positionals: string[] } | null {
  if (r.program !== program) {
    return null;
  }

  const all: string[] = [];
  let afterDashes = false;
  for (const a of args) {
    if (a === "--" && !afterDashes) {
      afterDashes = true;
    } else if (afterDashes || !a.startsWith("-")) {
      all.push(a);
    }
  }

  const sub = r.subcommand ?? [];
  if (sub.some((w, i) => all[i] !== w)) {
    return null;
  }

  const positionals = all.slice(sub.length);
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
  if (r.requiresRepo) {
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

  if (r.pathArgs) {
    for (const raw of m!.positionals) {
      const d = checkPath(policy, r.pathArgs, raw, cwd);
      if (d.effect !== "allow") {
        return d;
      }
    }
  }

  return allow(r.reason, r.id);
}

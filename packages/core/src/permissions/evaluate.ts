import { evaluateGit, repoFor } from "./git.js";
import { judgePath, resolvePath } from "./paths.js";
import { lex, type Segment } from "./shell.js";
import type { ArgPredicate, CommandRule, Decision, Policy, ToolCall } from "./types.js";

const allow = (reason: string, rule?: string): Decision => ({
  effect: "allow",
  reason,
  ...(rule ? { rule } : {}),
});

const deny = (reason: string, rule?: string): Decision => ({
  effect: "deny",
  reason,
  ...(rule ? { rule } : {}),
});

const ask = (reason: string, rule?: string): Decision => ({
  effect: "ask",
  reason,
  ...(rule ? { rule } : {}),
});

const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const MAX_CWDS = 8;

function checkPath(policy: Policy, access: "read" | "write", raw: string, cwd: string): Decision {
  const abs = resolvePath(raw, cwd, policy.home);
  if (access === "write" && SINKS.has(abs)) {
    return allow("Discarding output.", "paths.write.sink");
  }

  const verdict = judgePath(policy.paths[access], abs);
  if (verdict === "denied") {
    return deny(`${abs} is off limits for ${access}.`, `paths.${access}.deny`);
  }

  if (verdict === "outside") {
    // Writable paths are readable too (scratch, memory).
    if (access === "read" && judgePath(policy.paths.write, abs) === "allow") {
      return allow(`${abs} is readable.`, "paths.read.allow");
    }

    return deny(
      `${abs} is outside the paths this person may ${access}.`,
      `paths.${access}.outside`,
    );
  }

  return allow(`${abs} is ${access}able.`, `paths.${access}.allow`);
}

/** Worst of: deny, ask, allow. */
function worst(decisions: Decision[]): Decision {
  return (
    decisions.find((d) => d.effect === "deny") ??
    decisions.find((d) => d.effect === "ask") ??
    decisions[decisions.length - 1] ??
    allow("Nothing to check.")
  );
}

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

function evaluateCommandRules(
  policy: Policy,
  program: string,
  args: string[],
  cwd: string,
): Decision {
  const matches = policy.commands
    .map((r) => ({ r, m: matchRule(r, program, args) }))
    .filter((x) => x.m);

  const denied = matches.find((x) => x.r.effect === "deny");
  if (denied) {
    return deny(denied.r.reason, denied.r.id);
  }

  const hit = matches.find((x) => x.r.effect === "allow");
  if (!hit) {
    return ask(`${program} is not covered by the policy.`, "commands.unlisted");
  }

  const { r, m } = hit;
  if (r.requiresRepo) {
    if (flagValues(args, ["-R", "--repo"]) !== null) {
      return ask(
        "A -R/--repo target cannot be mapped to a granted repository.",
        "commands.repo-flag",
      );
    }

    const repo = repoFor(policy, cwd);
    if (!repo) {
      return ask(`${program} ran outside the granted repositories.`, "git.no-repo");
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

function evaluateSegment(policy: Policy, seg: Segment, cwd: string, call: ToolCall): Decision {
  const checks: Decision[] = [];
  for (const rd of seg.redirects) {
    checks.push(checkPath(policy, rd.op === "<" ? "read" : "write", rd.target, cwd));
  }

  let words = seg.words;
  if (words.length > 0) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      return ask(
        "Environment assignments before a command are not covered.",
        "commands.env-prefix",
      );
    }

    const program = words[0]!.slice(words[0]!.lastIndexOf("/") + 1);
    words = words.slice(1);
    if (program === "cd") {
      const target = words.filter((w) => !w.startsWith("-"))[0] ?? "~";
      if (target === "-") {
        checks.push(deny("cd - cannot be tracked.", "shell.cd"));
      } else {
        checks.push(...cdChecks(policy, target, cwd));
      }
    } else if (program === "git") {
      checks.push(evaluateGit(policy, words, cwd, call));
    } else if (program === "pushd" || program === "popd") {
      checks.push(ask(`${program} is not tracked.`, "shell.cd"));
    } else {
      checks.push(evaluateCommandRules(policy, program, words, cwd));
    }
  }

  return worst(checks.length > 0 ? checks : [allow("Empty command.")]);
}

function cdChecks(policy: Policy, target: string, cwd: string): Decision[] {
  const abs = resolvePath(target, cwd, policy.home);
  const d = checkPath(policy, "read", abs, cwd);
  return [d.effect === "allow" ? allow(`cd ${abs}`, "shell.cd") : d];
}

function evaluateShell(policy: Policy, call: ToolCall): Decision {
  const command = call.command;
  if (command === undefined || command.trim() === "") {
    return deny("Empty shell command.", "shell.empty");
  }

  const parsed = lex(command);
  if (!parsed.ok) {
    return deny(`Cannot analyse this command safely: ${parsed.reason}.`, "shell.unparseable");
  }

  const start = resolvePath(call.cwd ?? policy.defaultCwd, policy.defaultCwd, policy.home);
  // After a `cd` that is not chained with &&, the shell may still be in the old directory (the cd can fail),
  // so every possible directory is judged and the worst result wins.
  let cwds = [start];
  const results: Decision[] = [];
  for (const seg of parsed.segments) {
    const isCd = seg.words[0] === "cd" && seg.words.length <= 3;
    for (const cwd of cwds) {
      results.push(evaluateSegment(policy, seg, cwd, call));
    }

    if (isCd) {
      const detached = seg.sep === "|" || seg.sep === "&" || seg.before === "|";
      if (!detached) {
        const target = seg.words.filter((w, i) => i > 0 && !w.startsWith("-"))[0] ?? "~";
        const moved = cwds.map((c) => resolvePath(target, c, policy.home));
        cwds = seg.sep === "&&" ? moved : [...new Set([...cwds, ...moved])];
        if (cwds.length > MAX_CWDS) {
          return deny("Too many directory changes to track.", "shell.cd");
        }
      }
    }
  }

  const final = worst(results);
  if (final.effect !== "allow") {
    return final;
  }

  return allow(
    results.length === 1 ? final.reason : "Every command in the line is allowed.",
    final.rule,
  );
}

/** The reference decision function. Pure: no I/O, no clock. */
export function evaluate(policy: Policy, call: ToolCall): Decision {
  if (policy.tools.deny.includes(call.kind)) {
    return deny(`Tool ${call.kind} is denied.`, "tools.deny");
  }

  if (!policy.tools.allow.includes(call.kind)) {
    return deny(
      `Tool ${call.kind} is not available to the ${policy.profile} profile.`,
      "tools.allow",
    );
  }

  const cwd = resolvePath(call.cwd ?? policy.defaultCwd, policy.defaultCwd, policy.home);
  switch (call.kind) {
    case "read":
    case "search":
    case "write":
    case "edit": {
      const access: keyof Policy["paths"] =
        call.kind === "write" || call.kind === "edit" ? "write" : "read";

      if (call.path === undefined) {
        if (call.kind === "search") {
          return allow("Search in the working directory.", "tools.allow");
        }

        return deny("No path given.", "paths.missing");
      }

      return checkPath(policy, access, call.path, cwd);
    }

    case "shell":
      return evaluateShell(policy, call);
    case "ost":
      if (policy.ost && !policy.ost.allow.includes(call.command ?? "")) {
        return deny(
          `The ost verb ${call.command ?? "(unknown)"} is not available to the ${policy.profile} profile.`,
          "ost.verbs",
        );
      }

      return allow("ost is allowed.", "tools.allow");
    case "web_fetch":
    case "subagent":
      return allow(`${call.kind} is allowed.`, "tools.allow");
  }
}

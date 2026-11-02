import { deny } from "./decision.js";
import type { CommandRule, Decision } from "./types.js";

const GUESSED =
  " An option before the subcommand may take the next word as its value: write it as --option=value, or after the subcommand.";

/**
 * The refusal of a command outside a program's allow rules: it names the command and what the rules let it run, so an
 * agent can tell a real restriction from a misread command and take one that runs.
 */
export function narrowedDenial(
  program: string,
  allowRules: CommandRule[],
  words: string[],
  guessed: boolean,
): Decision {
  const subs = allowRules.map((r) => r.subcommand ?? []);
  const allowed = [...new Set(subs.filter((s) => s.length > 0).map((s) => s.join(" ")))];
  if (subs.some((s) => s.length === 0)) {
    allowed.push("the commands its rules match");
  }

  // As many words as the longest allowed subcommand that starts like this one, so `auth reconcile` is named whole.
  const depth = Math.max(1, ...subs.filter((s) => s[0] === words[0]).map((s) => s.length));
  const sub = words.slice(0, depth).join(" ");
  const what = sub === "" ? `${program} without a subcommand` : `${program} ${sub}`;
  const how = allowed.includes(sub) ? " with these arguments" : "";

  return deny(
    `${what} is refused${how}: ${program} here allows ${allowed.join(", ")}.${guessed ? GUESSED : ""}`,
    "commands.narrowed",
  );
}

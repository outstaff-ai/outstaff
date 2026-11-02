const isOption = (a: string): boolean => a.startsWith("-") && a !== "-" && a !== "--";

/**
 * The words that are not options, leaving out the word after each option in `valued` (its value); after `--` every
 * word is one.
 */
export function operands(args: readonly string[], valued: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      return [...out, ...args.slice(i + 1)];
    }

    if (!a.startsWith("-")) {
      out.push(a);
      continue;
    }

    i += valued.includes(a) ? 1 : 0;
  }

  return out;
}

/** Whether an option not known to take a value may still take the next word as one. */
const mayTakeValue = (option: string, next: string, flags: readonly string[]): boolean =>
  !flags.includes(option) && !option.includes("=") && !next.startsWith("-");

/**
 * How many leading operands may be the value of an option before them that is neither in `valued` nor in `flags`:
 * `-c prod -v x delete` gives 2 (`prod` and `x`), so `delete` may be the subcommand. `--name=value` is one word, a
 * `valued` option's value is never an operand and a flag never takes one.
 */
export function leadingValues(
  args: readonly string[],
  valued: readonly string[] = [],
  flags: readonly string[] = [],
): number {
  let n = 0;
  for (let i = 0; i < args.length - 1 && isOption(args[i]!); i++) {
    if (valued.includes(args[i]!)) {
      i++;
    } else if (mayTakeValue(args[i]!, args[i + 1]!, flags)) {
      n++;
      i++;
    }
  }

  return n;
}

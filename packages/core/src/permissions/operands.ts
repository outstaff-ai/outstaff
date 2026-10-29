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

/**
 * How many leading operands may be the value of the option before them, when nothing says which options take one:
 * `-c prod -v x delete` gives 2 (`prod` and `x`), so `delete` may be the subcommand. `--name=value` is one word.
 */
export function leadingValues(args: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < args.length - 1 && isOption(args[i]!); i++) {
    if (!args[i + 1]!.startsWith("-") && !args[i]!.includes("=")) {
      n++;
      i++;
    }
  }

  return n;
}

import type { ModelUsage } from "@outstaff/core";

/** List prices in USD per million tokens. Cache writes are the 5-minute rate (1.25 times input). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

/**
 * The adapter's own price table, for a model the SDK does not price: Anthropic's API list prices by model id prefix.
 * The longest matching prefix wins, so `claude-opus-5-5` is not priced as `claude-opus-5`. Haiku 5.5 is at its rate
 * for prompts up to 100K tokens.
 */
const PRICES: readonly (readonly [string, Price])[] = (
  [
    ["claude-fable-5-1", price(10, 50, 0.25)],
    ["claude-mythos-5-1", price(10, 50, 0.25)],
    ["claude-fable-5", price(10, 50, 1)],
    ["claude-mythos-5", price(10, 50, 1)],
    ["claude-opus-5-5", price(4, 20, 0.2)],
    ["claude-opus-5", price(5, 25, 0.5)],
    ["claude-opus-4-8", price(5, 25, 0.5)],
    ["claude-opus-4-7", price(5, 25, 0.5)],
    ["claude-opus-4-6", price(5, 25, 0.5)],
    ["claude-sonnet-5-5", price(2, 10, 0.2)],
    ["claude-sonnet-5", price(2, 10, 0.2)],
    ["claude-sonnet-4-6", price(3, 15, 0.3)],
    ["claude-haiku-5-5", price(0.1, 0.5, 0.01)],
    ["claude-haiku-4-5", price(1, 5, 0.1)],
  ] as const
).toSorted((a, b) => b[0].length - a[0].length);

/** The model id without a provider prefix (`us.anthropic.`) or a context suffix (`[1m]`), in lower case. */
function bare(model: string): string {
  const lower = model.toLowerCase().replace(/\[[^\]]*\]$/, "");
  const at = lower.lastIndexOf("anthropic.");
  return at < 0 ? lower : lower.slice(at + "anthropic.".length);
}

/** What the tokens cost at the model's list price; undefined for a model the table does not know. */
export function listPrice(model: string, tokens: Omit<ModelUsage, "costUsd">): number | undefined {
  const id = bare(model);
  const p = PRICES.find(([prefix]) => id.startsWith(prefix))?.[1];
  if (!p) {
    return undefined;
  }

  const cost =
    tokens.inputTokens * p.input +
    tokens.outputTokens * p.output +
    tokens.cacheReadTokens * p.cacheRead +
    tokens.cacheCreationTokens * p.cacheWrite;

  return cost / 1_000_000;
}

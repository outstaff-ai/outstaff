import type { ModelUsage, SessionUsage } from "@outstaff/core";
import { listPrice } from "./prices.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The SDK's own cost, unless it says it had no price for the model and guessed. */
function sdkCost(raw: Rec): number | undefined {
  const cost = raw["costUSD"];
  return typeof cost === "number" && Number.isFinite(cost) && raw["costBasis"] !== "unknown"
    ? cost
    : undefined;
}

function modelUsage(model: string, raw: Rec): ModelUsage {
  const tokens = {
    inputTokens: count(raw["inputTokens"]),
    outputTokens: count(raw["outputTokens"]),
    cacheReadTokens: count(raw["cacheReadInputTokens"]),
    cacheCreationTokens: count(raw["cacheCreationInputTokens"]),
  };

  const cost = sdkCost(raw) ?? listPrice(model, tokens);
  return { ...tokens, ...(cost === undefined ? {} : { costUsd: cost }) };
}

/**
 * The session's usage so far from a result's `modelUsage`: every model the session called, main loop, subagents and
 * compaction alike. The cost is the SDK's where it priced the model, else the adapter's list price. Undefined when the
 * result carries none.
 */
export function sessionUsage(result: Rec): SessionUsage | undefined {
  const raw = result["modelUsage"];
  if (!isRec(raw)) {
    return undefined;
  }

  const entries = Object.entries(raw).flatMap(([model, u]) =>
    isRec(u) ? [[model, modelUsage(model, u)] as const] : [],
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

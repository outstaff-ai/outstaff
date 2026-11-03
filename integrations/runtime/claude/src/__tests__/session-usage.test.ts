import { describe, expect, it } from "vitest";
import { listPrice } from "#/prices.js";
import { sessionUsage } from "#/session-usage.js";
import { mapMessage } from "#/messages.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const tokens = (input: number, output: number, read = 0, write = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheCreationTokens: write,
});

describe("listPrice", () => {
  it("prices tokens at the longest matching model prefix", () => {
    expect(listPrice("claude-opus-5-5", tokens(1_000_000, 1_000_000))).toBe(24);
    expect(listPrice("claude-opus-5", tokens(1_000_000, 0))).toBe(5);
    expect(listPrice("claude-opus-5-20260101", tokens(0, 1_000_000))).toBe(25);
    expect(listPrice("claude-sonnet-5-5", tokens(0, 0, 1_000_000, 1_000_000))).toBeCloseTo(2.7);
  });

  it("reads provider and context forms of a model id", () => {
    expect(listPrice("us.anthropic.claude-haiku-4-5", tokens(1_000_000, 0))).toBe(1);
    expect(listPrice("Claude-Opus-4-8[1m]", tokens(1_000_000, 0))).toBe(5);
  });

  it("knows no price for a model it does not list", () => {
    expect(listPrice("opus", tokens(1, 1))).toBeUndefined();
  });
});

describe("sessionUsage", () => {
  it("reads every model of the result, with the SDK's cost", () => {
    expect(
      sessionUsage({
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 40,
            costUSD: 0.5,
            costBasis: "list",
          },
          "claude-haiku-5-5": { inputTokens: 1_000_000, outputTokens: -3, costUSD: "x" },
          broken: "nope",
        },
      }),
    ).toEqual({
      "claude-opus-5-5": { ...tokens(10, 20, 300, 40), costUsd: 0.5 },
      "claude-haiku-5-5": { ...tokens(1_000_000, 0), costUsd: 0.1 },
    });
  });

  it("prices a model itself when the SDK guessed, and leaves the cost out when it cannot", () => {
    expect(
      sessionUsage({
        modelUsage: {
          "claude-sonnet-5-5": { outputTokens: 1_000_000, costUSD: 99, costBasis: "unknown" },
          "acme-model": { inputTokens: 5, costUSD: Number.NaN },
        },
      }),
    ).toEqual({
      "claude-sonnet-5-5": { ...tokens(0, 1_000_000), costUsd: 10 },
      "acme-model": tokens(5, 0),
    });
  });

  it("is undefined without model usage", () => {
    expect(sessionUsage({})).toBeUndefined();
    expect(sessionUsage({ modelUsage: [] })).toBeUndefined();
    expect(sessionUsage({ modelUsage: { a: 1 } })).toBeUndefined();
  });

  it("goes on the finished event", () => {
    const msg = {
      type: "result",
      subtype: "success",
      result: "done",
      modelUsage: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 2, costUSD: 0.01 } },
    } as unknown as SDKMessage;

    expect(mapMessage(msg, { lastText: "" })).toEqual([
      {
        type: "finished",
        ok: true,
        text: "done",
        usage: { "claude-opus-5-5": { ...tokens(1, 2), costUsd: 0.01 } },
      },
    ]);
  });
});

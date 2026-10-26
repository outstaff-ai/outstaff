import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { mapMessage, parseUsage } from "../messages.js";

const msg = (x: unknown) => x as SDKMessage;
const map = (x: unknown, signal?: AbortSignal) => mapMessage(msg(x), { lastText: "" }, signal);

const limit = (info: unknown) => ({ type: "rate_limit_event", rate_limit_info: info });

describe("parseUsage", () => {
  it.each([
    ["a string", "rate_limit_event"],
    ["null", null],
    ["an array", []],
    ["another message type", { type: "result" }],
    ["no rate_limit_info", { type: "rate_limit_event" }],
    ["rate_limit_info that is not an object", limit("x")],
  ])("gives nothing for %s", (_name, input) => {
    expect(parseUsage(input)).toBeUndefined();
  });

  it("keeps a window without a reset time when resetsAt is not a valid timestamp", () => {
    for (const resetsAt of ["soon", Number.NaN, 8.64e15 + 1]) {
      expect(
        parseUsage(limit({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt } } })),
      ).toEqual({
        type: "usage",
        windows: [{ name: "five_hour", utilization: 0.5 }],
      });
    }
  });

  it("skips windows that are not objects or have no numeric utilization", () => {
    const usage = parseUsage(
      limit({
        unifiedWindows: {
          a: "bad",
          b: { utilization: "high" },
          c: { utilization: Number.POSITIVE_INFINITY },
          d: { utilization: 0.3, resetsAt: 1792761000 },
        },
      }),
    );

    expect(usage).toEqual({
      type: "usage",
      windows: [
        { name: "d", utilization: 0.3, resetsAt: new Date(1792761000 * 1000).toISOString() },
      ],
    });
  });

  it("falls back to the single rateLimitType window when there are no unified windows", () => {
    expect(
      parseUsage(limit({ rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1792761000 })),
    ).toEqual({
      type: "usage",
      windows: [
        {
          name: "five_hour",
          utilization: 0.9,
          resetsAt: new Date(1792761000 * 1000).toISOString(),
        },
      ],
    });
  });

  it("reports nothing when neither shape carries a utilization", () => {
    expect(parseUsage(limit({ rateLimitType: "five_hour" }))).toBeUndefined();
    expect(parseUsage(limit({ status: "allowed" }))).toBeUndefined();
    expect(parseUsage(limit({ unifiedWindows: {}, rateLimitType: 5 }))).toBeUndefined();
  });
});

describe("mapMessage", () => {
  it("starts the session only for an init message with a session id", () => {
    expect(map({ type: "system", subtype: "init", session_id: "s1" })).toEqual([
      { type: "started", sessionId: "s1" },
    ]);

    expect(map({ type: "system", subtype: "init" })).toEqual([]);
    expect(map({ type: "system", subtype: "other", session_id: "s1" })).toEqual([]);
  });

  it("ignores subagent text and messages without text blocks", () => {
    expect(
      map({
        type: "assistant",
        parent_tool_use_id: "t1",
        message: { content: [{ type: "text", text: "inner" }] },
      }),
    ).toEqual([]);

    expect(map({ type: "assistant", message: "no content" })).toEqual([]);
    expect(map({ type: "assistant", message: { content: "text" } })).toEqual([]);
    expect(
      map({
        type: "assistant",
        message: { content: [{ type: "tool_use" }, null, { type: "text", text: 5 }] },
      }),
    ).toEqual([]);
  });

  it("joins the text blocks of an assistant message and remembers them", () => {
    const state = { lastText: "" };
    const events = mapMessage(
      msg({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }],
        },
      }),
      state,
    );

    expect(events).toEqual([{ type: "text", text: "ab" }]);
    expect(state.lastText).toBe("ab");
  });

  it("maps a rate limit event to usage, and one without windows to nothing", () => {
    expect(map(limit({ rateLimitType: "x", utilization: 0.1 }))).toEqual([
      { type: "usage", windows: [{ name: "x", utilization: 0.1 }] },
    ]);

    expect(map(limit({ status: "allowed" }))).toEqual([]);
  });

  it("ignores message types it does not know", () => {
    expect(map({ type: "stream_event" })).toEqual([]);
  });

  describe("result", () => {
    it("falls back to the last assistant text when the result has none", () => {
      const state = { lastText: "last words" };
      expect(mapMessage(msg({ type: "result", subtype: "success" }), state)).toEqual([
        { type: "finished", ok: true, text: "last words" },
      ]);
    });

    it("reports the SDK's errors, keeping only strings", () => {
      expect(
        map({
          type: "result",
          subtype: "error_during_execution",
          errors: ["a", 3, "b"],
          result: "r",
        }),
      ).toEqual([{ type: "finished", ok: false, text: "r", error: "a; b" }]);
    });

    it("names the subtype, or a generic error, when no errors are listed", () => {
      expect(map({ type: "result", subtype: "error_max_turns", errors: [] })).toEqual([
        { type: "finished", ok: false, text: "", error: "error_max_turns" },
      ]);

      expect(map({ type: "result", is_error: true })).toEqual([
        { type: "finished", ok: false, text: "", error: "error" },
      ]);
    });

    it("treats an error flag on a success subtype as a failure", () => {
      expect(map({ type: "result", subtype: "success", is_error: true, result: "x" })).toEqual([
        { type: "finished", ok: false, text: "x", error: "success" },
      ]);
    });

    it("marks an aborted run interrupted, by signal or by the SDK's terminal reason", () => {
      const aborted = AbortSignal.abort();
      expect(map({ type: "result", subtype: "success", result: "x" }, aborted)).toEqual([
        { type: "finished", ok: false, text: "x", interrupted: true },
      ]);

      expect(
        map({
          type: "result",
          subtype: "success",
          result: "x",
          terminal_reason: "aborted_streaming",
        }),
      ).toEqual([{ type: "finished", ok: false, text: "x", interrupted: true }]);
    });

    it("carries the cost only when it is a number", () => {
      expect(
        map({ type: "result", subtype: "success", total_cost_usd: "1" })[0],
      ).not.toHaveProperty("costUsd");
    });
  });
});

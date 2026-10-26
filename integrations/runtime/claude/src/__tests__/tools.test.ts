import { PortError, type RuntimeTool } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toSdkTools } from "../tools.js";

type Handler = (
  args: unknown,
  extra: unknown,
) => Promise<{ isError?: boolean; content: { text: string }[] }>;

const toolOf = (handler: RuntimeTool["handler"], input: RuntimeTool["input"] = z.object({})) =>
  ({ name: "t", description: "d", input, handler }) as RuntimeTool;

const call = (t: RuntimeTool, workItemId?: string) =>
  (toSdkTools([t], workItemId)[0]!.handler as unknown as Handler)({}, {});

describe("toSdkTools", () => {
  it("refuses a tool whose input is not a zod object schema", () => {
    const bad = toolOf(async () => "x", z.string());
    expect(() => toSdkTools([bad])).toThrow(PortError);
    expect(() => toSdkTools([bad])).toThrow(/input must be a zod object schema/);
  });

  it("hands the work item to the handler only when the run has one", async () => {
    const seen: unknown[] = [];
    const t = toolOf(async (_args, ctx) => {
      seen.push(ctx);
      return "ok";
    });

    expect(await call(t)).toEqual({ content: [{ type: "text", text: "ok" }] });
    await call(t, "w1");
    expect(seen).toEqual([{}, { workItemId: "w1" }]);
  });

  it("returns a handler error as an error result, whatever was thrown", async () => {
    expect(
      await call(
        toolOf(async () => {
          throw new Error("boom");
        }),
      ),
    ).toEqual({ isError: true, content: [{ type: "text", text: "boom" }] });

    expect(
      await call(
        toolOf(async () => {
          throw "plain string";
        }),
      ),
    ).toEqual({ isError: true, content: [{ type: "text", text: "plain string" }] });
  });
});

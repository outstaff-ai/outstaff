import { describe, expect, it } from "vitest";
import { onlyArg } from "#/commands/args.js";

describe("onlyArg", () => {
  it("returns the single argument", () => {
    expect(onlyArg(["sam"])).toBe("sam");
  });

  it("returns undefined for none or several", () => {
    expect(onlyArg([])).toBeUndefined();
    expect(onlyArg(["sam", "kim"])).toBeUndefined();
  });
});

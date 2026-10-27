import { describe, expect, it } from "vitest";
import { name } from "#/index.js";

describe("@outstaff/core", () => {
  it("exports its package name", () => {
    expect(name).toBe("@outstaff/core");
  });
});

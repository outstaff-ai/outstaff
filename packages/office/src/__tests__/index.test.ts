import { describe, expect, it } from "vitest";
import { name } from "#/index.js";

describe("@outstaff/office", () => {
  it("exports its package name", () => {
    expect(name).toBe("@outstaff/office");
  });
});

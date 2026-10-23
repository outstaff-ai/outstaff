import { describe, expect, it } from "vitest";
import { name } from "./index.js";

describe("@outstaff/agent", () => {
  it("exports its package name", () => {
    expect(name).toBe("@outstaff/agent");
  });
});

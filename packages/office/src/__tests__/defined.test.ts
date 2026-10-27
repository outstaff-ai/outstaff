import { describe, expect, it } from "vitest";
import { defined } from "#/defined.js";

describe("defined", () => {
  it("drops undefined properties", () => {
    expect(defined({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(Object.keys(defined({ a: undefined }))).toEqual([]);
  });

  it("keeps the other falsy values", () => {
    expect(defined({ a: null, b: "", c: 0, d: false })).toEqual({ a: null, b: "", c: 0, d: false });
  });
});

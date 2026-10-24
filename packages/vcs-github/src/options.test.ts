import { describe, expect, it } from "vitest";
import { githubOptions } from "./options.js";

describe("githubOptions", () => {
  it("rejects the removed appSlugs option", () => {
    expect(githubOptions.safeParse({ appSlugs: { sam: "acme-sam" } }).success).toBe(false);
  });
});

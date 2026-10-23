import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { findRanges, isPinned } from "./versions.mjs";

describe("version pinning", () => {
  it("accepts exact versions and workspace links", () => {
    for (const spec of ["1.2.3", "0.0.1", "2.0.0-rc.1", "workspace:*", "workspace:^"]) {
      expect(isPinned(spec)).toBe(true);
    }
  });

  it("rejects ranges and tags", () => {
    for (const spec of ["^1.2.3", "~1.2.3", ">=1", "1.x", "24", "latest", "*"]) {
      expect(isPinned(spec)).toBe(false);
    }
  });

  it("checks dependencies but not peer dependencies", () => {
    const ranges = findRanges({
      dependencies: { a: "1.0.0", b: "^2.0.0" },
      devDependencies: { c: "~3.0.0" },
      peerDependencies: { d: "^4.0.0" },
    });

    expect(ranges).toEqual([
      { field: "dependencies", name: "b", spec: "^2.0.0" },
      { field: "devDependencies", name: "c", spec: "~3.0.0" },
    ]);
  });
});

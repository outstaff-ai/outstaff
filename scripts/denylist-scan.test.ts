import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { parsePatterns, scanText } from "./denylist-scan.mjs";

describe("parsePatterns", () => {
  it("skips blank lines, numbers by line order and flags invalid regexes", () => {
    const { patterns, invalid } = parsePatterns("acme-secret\n\n(unclosed\r\nfoo|bar\n");
    expect(patterns.map((p: { n: number }) => p.n)).toEqual([1, 3]);
    expect(invalid).toEqual([2]);
  });
});

describe("scanText", () => {
  const { patterns } = parsePatterns("acme-secret\nproject-(x|y)");

  it("matches case-insensitively and reports line and pattern number only", () => {
    const hits = scanText("ok\nuses ACME-Secret here\nPROJECT-y", patterns);
    expect(hits).toEqual([
      { line: 2, pattern: 1 },
      { line: 3, pattern: 2 },
    ]);
  });

  it("returns nothing for clean text", () => {
    expect(scanText("nothing to see", patterns)).toEqual([]);
  });

  it("never leaks the matched text in its result", () => {
    expect(JSON.stringify(scanText("acme-secret", patterns))).not.toContain("acme");
  });
});

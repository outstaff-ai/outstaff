import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { exemption, exportKinds, isSource, layoutProblems, MAX_LINES } from "../file-layout.mjs";

describe("file layout", () => {
  it("covers TypeScript source but not tests or declarations", () => {
    expect(isSource("packages/core/src/config/schema.ts")).toBe(true);
    expect(isSource("scripts/release-lib.ts")).toBe(true);
    expect(isSource("packages/core/src/config/__tests__/schema.test.ts")).toBe(false);
    expect(isSource("packages/core/src/config/__tests__/fixtures.ts")).toBe(false);
    expect(isSource("packages/core/dist/index.d.ts")).toBe(false);
    expect(isSource("scripts/tests-layout.mjs")).toBe(false);
  });

  it("exempts listed files and folders", () => {
    expect(exemption("packages/office/src/engine/engine.ts")).toMatch(/redesign/);
    expect(exemption("packages/core/src/workflow/presets.ts")).toMatch(/redesign/);
    expect(exemption("packages/core/src/workflow/evaluate.ts")).toBeUndefined();
  });

  it("classifies exports", () => {
    const cases: [string, { types: boolean; values: boolean }][] = [
      ["export type A = string;\nexport interface B {}\n", { types: true, values: false }],
      ["export const a = 1;\nexport function b() {}\n", { types: false, values: true }],
      ["export { a, type B } from './x.js';\n", { types: true, values: true }],
      [
        "export type { A } from './x.js';\nexport type * from './y.js';\n",
        { types: true, values: false },
      ],
      ["export * from './x.js';\n", { types: false, values: true }],
    ];

    for (const [source, kinds] of cases) {
      expect(exportKinds(source)).toEqual(kinds);
    }
  });

  it("is not fooled by glob strings that look like comments", () => {
    const source = 'const glob = "src/**/__tests__/**/*.test.ts";\nexport type A = string;\n';

    expect(exportKinds(`${source}export const a = 1;\n`)).toEqual({ types: true, values: true });
  });

  it("flags long files and mixed exports outside index files", () => {
    const long = "const a = 1;\n".repeat(MAX_LINES + 1);
    const mixed = "export type A = string;\nexport const a = 1;\n";
    const files: Record<string, string> = {
      "packages/core/src/long.ts": long,
      "packages/core/src/mixed.ts": mixed,
      "packages/core/src/index.ts": mixed,
      "packages/office/src/engine/engine.ts": long + mixed,
    };

    const problems = layoutProblems(Object.keys(files), (file: string) => files[file]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^packages\/core\/src\/long\.ts: 301 lines/);
    expect(problems[1]).toMatch(
      /^packages\/core\/src\/mixed\.ts: exports types and runtime values/,
    );
  });
});

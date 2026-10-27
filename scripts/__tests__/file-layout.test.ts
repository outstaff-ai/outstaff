import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import {
  crossPackageImports,
  integrationDependencies,
  exemption,
  exportKinds,
  isSource,
  layoutProblems,
  MAX_LINES,
  relativeSpecifiers,
} from "../file-layout.mjs";

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

  it("finds every form of relative specifier", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "../b.js";',
      'export * from "./c.js";',
      'import "./d.js";',
      'const e = await import("./e.js");',
      'vi.mock("../f.js");',
      'import { g } from "@outstaff/core";',
    ].join("\n");

    expect(relativeSpecifiers(source)).toEqual([
      "./a.js",
      "../b.js",
      "./c.js",
      "./d.js",
      "./e.js",
      "../f.js",
    ]);
  });

  it("flags relative imports that leave their package", () => {
    const files: Record<string, string> = {
      "packages/cli/package.json": "{}",
      "packages/core/package.json": "{}",
      "packages/cli/src/a.ts":
        'import { b } from "./b.js";\nimport { c } from "../../core/src/c.js";\n',
      "packages/cli/scripts/gen.ts": 'import { a } from "../src/a.js";\n',
      "e2e/stub.ts": 'import type { C } from "../packages/core/src/c.ts";\n',
    };

    const problems = crossPackageImports(Object.keys(files), (file: string) => files[file]);

    expect(problems).toEqual([
      "packages/cli/src/a.ts: ../../core/src/c.js leaves the package; import it by package name",
      "e2e/stub.ts: ../packages/core/src/c.ts leaves the package; import it by package name",
    ]);
  });

  it("lets an integration depend only on core, protocol and shared packages", () => {
    const pkg = (name: string, deps: Record<string, string>, dev: Record<string, string> = {}) =>
      JSON.stringify({ name, dependencies: deps, devDependencies: dev });

    const files: Record<string, string> = {
      "integrations/shared/acme/package.json": pkg("@outstaff/integration.shared.acme", {
        "@outstaff/core": "workspace:*",
      }),
      "integrations/tracker/acme/package.json": pkg(
        "@outstaff/integration.tracker.acme",
        { "@outstaff/integration.shared.acme": "workspace:*", zod: "4.6.7" },
        { "@outstaff/testing.acme": "workspace:*" },
      ),
      "integrations/knowledge/acme/package.json": pkg("@outstaff/integration.knowledge.acme", {
        "@outstaff/integration.tracker.acme": "workspace:*",
        "@outstaff/testing.acme": "workspace:*",
      }),
      "integrations/tracker/acme/src/a.ts":
        'import { b } from "@outstaff/integration.shared.acme";\nimport { c } from "@outstaff/protocol";\n',
      "integrations/tracker/acme/src/__tests__/a.test.ts":
        'import { f } from "@outstaff/testing.acme";\n',
      "integrations/knowledge/acme/src/k.ts":
        'import { t } from "@outstaff/integration.tracker.acme";\nimport { f } from "@outstaff/testing.acme";\n',
    };

    const problems = integrationDependencies(Object.keys(files), (file: string) => files[file]);

    expect(problems.map((p) => p.split(";")[0])).toEqual([
      "integrations/knowledge/acme/package.json: dependencies names @outstaff/integration.tracker.acme",
      "integrations/knowledge/acme/package.json: dependencies names @outstaff/testing.acme",
      "integrations/knowledge/acme/src/k.ts: imports @outstaff/integration.tracker.acme",
      "integrations/knowledge/acme/src/k.ts: imports @outstaff/testing.acme",
    ]);
  });
});
